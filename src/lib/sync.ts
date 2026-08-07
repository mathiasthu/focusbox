import { decryptBlob, encryptBlob } from "./crypto";
import { mergeSettings, mergeTasks, resolveNotes } from "./merge";
import {
  KEY_NOTES,
  KEY_SETTINGS,
  KEY_TASKS,
  VERSIONED_KEYS,
  clampStamp,
  newNotesConflictKey,
  type NotesValue,
  type SettingsValue,
  type SyncedTask,
  type TasksBlob,
} from "./syncTypes";
import { ApiError, ConflictError, type SyncApi } from "./api";

export interface LocalData {
  tasks: SyncedTask[];
  notes: NotesValue;
  settings: SettingsValue;
}

export interface SyncState {
  /** last-synced server version per blob key */
  versions: Record<string, number>;
  /** updated_at of the last successfully-synced notes (baseline for conflict detection) */
  notesBaseUpdatedAt: number | null;
}

export function emptySyncState(): SyncState {
  return { versions: {}, notesBaseUpdatedAt: null };
}

export interface SyncResult {
  local: LocalData;
  state: SyncState;
  conflicts: string[]; // keys of any notes conflict-copies written this run
}

const MAX_CONFLICT_RETRIES = 4;

/** Raised when the server's framing contradicts what this client already knows to be
 * true. Not a transport error and not retryable: the response is well-formed, it just
 * cannot have come from an honest server holding this account's data. */
export class SyncIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncIntegrityError";
  }
}

function stableEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Non-timestamp numeric field: finite, but no clamp (ordering has no clock semantics). */
function finite(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/**
 * Tracks whether ingest normalization actually rewrote anything this cycle.
 *
 * This has to feed the push decision, and the reason is the whole point of the clamp.
 * The `stableEq(merged, remote)` short-circuit below compares the merge result against
 * the ALREADY-NORMALIZED remote, so a clamp can never by itself make them differ — which
 * means the corrected value is never written back and the server keeps the poisoned one.
 * Because the clamp target is `now`, and `now` advances every cycle, the item is re-minted
 * as the newest thing in the account on every single sync: a deleted task outranks its own
 * tombstone forever, a note edit loses LWW forever, a setting reverts forever. Forcing the
 * push repairs the stored value once, after which the user's next edit is simply newer and
 * wins normally.
 */
interface Normalization {
  rewrote: boolean;
}

function normalizeTask(t: SyncedTask, now: number, n: Normalization): SyncedTask {
  const updated_at = clampStamp(t.updated_at, 0, now);
  const order = finite(t.order, 0);
  // NaN !== NaN, so a garbage value counts as rewritten too — which is what we want.
  if (updated_at !== t.updated_at || order !== t.order) n.rewrote = true;
  return { ...t, updated_at, order };
}

function normalizeStamp(raw: unknown, now: number, n: Normalization): number {
  const value = clampStamp(raw, 0, now);
  if (value !== raw) n.rewrote = true;
  return value;
}

async function pull<T>(
  api: SyncApi,
  token: string,
  adk: Uint8Array,
  key: string,
): Promise<{ value: T; version: number }> {
  const blob = await api.getBlob(token, key);
  // The server does not get to decide which blob this is. A response labelled with a
  // different key than the one requested is a misroute — the precondition for serving
  // one blob's ciphertext as another's. (The AEAD binding in decryptBlob is the check
  // that actually holds against a lying server; this catches the honest-server bug
  // and reports it as what it is.)
  if (blob.key !== key) {
    throw new SyncIntegrityError(`sync server answered "${key}" with blob "${blob.key}"`);
  }
  const plain = decryptBlob(blob.ciphertext, blob.nonce, adk, key);
  return { value: JSON.parse(plain) as T, version: blob.version };
}

async function pushValue(
  api: SyncApi,
  token: string,
  adk: Uint8Array,
  key: string,
  value: unknown,
  baseVersion: number,
): Promise<number> {
  const { ciphertext, nonce } = encryptBlob(JSON.stringify(value), adk, key);
  const res = await api.pushBlob(token, {
    key,
    ciphertext,
    nonce,
    base_version: baseVersion,
  });
  return res.version;
}

/**
 * The server's claimed version for `key`, rejected if it moved backwards.
 *
 * `state.versions` was written on every cycle and read exactly once — to fill in
 * `base_version` for the *server* to check, which is worth nothing when the server is the
 * adversary. Checking it here is what makes it a real defense: a rollback (an old
 * ciphertext replayed, or the blob dropped entirely) can no longer be presented as the
 * current state and merged in as though the user's later edits never happened.
 */
function serverVersionFor(
  key: string,
  manifest: Map<string, number>,
  known: Record<string, number>,
): number {
  const claimed = manifest.get(key) ?? 0;
  const persisted = known[key] ?? 0;
  if (claimed < persisted) {
    throw new SyncIntegrityError(
      `sync server rolled "${key}" back from version ${persisted} to ${claimed}`,
    );
  }
  return claimed;
}

/** A conflict copy is a best-effort safety net, never the point of the cycle. A server
 * that refuses the write (quota 413, copy cap, …) must not abort the sync that is about
 * to preserve the user's actual note — but a network/5xx failure still propagates, so
 * the normal retry path sees it. */
function tolerateConflictCopyFailure(e: unknown): void {
  if (e instanceof ConflictError) return;
  if (e instanceof ApiError && e.status < 500) {
    console.warn("Focusbox: couldn't save a notes backup copy; continuing.", e);
    return;
  }
  throw e;
}

/** Sync one full cycle: pull changed blobs, merge, push local contributions. */
export async function syncOnce(opts: {
  api: SyncApi;
  token: string;
  adk: Uint8Array;
  local: LocalData;
  state: SyncState;
  /** this device's clock, for the remote-timestamp skew clamp */
  now: number;
}): Promise<SyncResult> {
  const { api, token, adk, now } = opts;
  const local: LocalData = { ...opts.local };
  const state: SyncState = {
    versions: { ...opts.state.versions },
    notesBaseUpdatedAt: opts.state.notesBaseUpdatedAt,
  };
  const conflicts: string[] = [];

  const manifest = await api.getManifest(token);
  const mv = new Map(manifest.map((m) => [m.key, m.version]));
  // Check every versioned key up front, so a rollback aborts before any blob is merged
  // or pushed rather than after the first one has already been applied.
  for (const k of VERSIONED_KEYS) serverVersionFor(k, mv, opts.state.versions);

  // ---- tasks: per-item LWW union ----
  {
    let serverV = serverVersionFor(KEY_TASKS, mv, opts.state.versions);
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      let remote: SyncedTask[] = [];
      let baseV = 0;
      const norm: Normalization = { rewrote: false };
      if (serverV > 0) {
        const pr = await pull<TasksBlob>(api, token, adk, KEY_TASKS);
        remote = (pr.value.items ?? []).map((t) => normalizeTask(t, now, norm));
        baseV = pr.version;
      }
      const merged = mergeTasks(local.tasks, remote);
      if (serverV > 0 && !norm.rewrote && stableEq(merged, remote)) {
        local.tasks = merged;
        state.versions[KEY_TASKS] = serverV;
        break;
      }
      try {
        const v = await pushValue(api, token, adk, KEY_TASKS, { items: merged } as TasksBlob, baseV);
        local.tasks = merged;
        state.versions[KEY_TASKS] = v;
        break;
      } catch (e) {
        if (e instanceof ConflictError) {
          serverV = e.currentVersion;
          continue;
        }
        throw e;
      }
    }
  }

  // ---- settings: LWW ----
  {
    let serverV = serverVersionFor(KEY_SETTINGS, mv, opts.state.versions);
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      let remote: SettingsValue | null = null;
      let baseV = 0;
      const norm: Normalization = { rewrote: false };
      if (serverV > 0) {
        const pr = await pull<SettingsValue>(api, token, adk, KEY_SETTINGS);
        remote = { ...pr.value, updated_at: normalizeStamp(pr.value.updated_at, now, norm) };
        baseV = pr.version;
      }
      const merged = remote ? mergeSettings(local.settings, remote) : local.settings;
      if (serverV > 0 && !norm.rewrote && stableEq(merged, remote)) {
        local.settings = merged;
        state.versions[KEY_SETTINGS] = serverV;
        break;
      }
      try {
        const v = await pushValue(api, token, adk, KEY_SETTINGS, merged, baseV);
        local.settings = merged;
        state.versions[KEY_SETTINGS] = v;
        break;
      } catch (e) {
        if (e instanceof ConflictError) {
          serverV = e.currentVersion;
          continue;
        }
        throw e;
      }
    }
  }

  // ---- notes: LWW with conflict-copy ----
  {
    let serverV = serverVersionFor(KEY_NOTES, mv, opts.state.versions);
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      let remote: NotesValue | null = null;
      let baseV = 0;
      const norm: Normalization = { rewrote: false };
      if (serverV > 0) {
        const pr = await pull<NotesValue>(api, token, adk, KEY_NOTES);
        remote = { ...pr.value, updated_at: normalizeStamp(pr.value.updated_at, now, norm) };
        baseV = pr.version;
      }
      if (!remote) {
        // No server notes yet: establish it from local.
        const v = await pushValue(api, token, adk, KEY_NOTES, local.notes, 0);
        state.versions[KEY_NOTES] = v;
        state.notesBaseUpdatedAt = local.notes.updated_at;
        break;
      }
      const res = resolveNotes(local.notes, remote, state.notesBaseUpdatedAt);
      if (res.conflict) {
        const ckey = newNotesConflictKey();
        // best-effort: never let a failed backup copy abort the cycle that preserves
        // the note the user actually kept
        try {
          await pushValue(api, token, adk, ckey, res.conflict, 0);
          conflicts.push(ckey);
        } catch (e) {
          tolerateConflictCopyFailure(e);
        }
      }
      if (!norm.rewrote && stableEq(res.current, remote)) {
        local.notes = res.current;
        state.versions[KEY_NOTES] = serverV;
        state.notesBaseUpdatedAt = res.current.updated_at;
        break;
      }
      try {
        const v = await pushValue(api, token, adk, KEY_NOTES, res.current, baseV);
        local.notes = res.current;
        state.versions[KEY_NOTES] = v;
        state.notesBaseUpdatedAt = res.current.updated_at;
        break;
      } catch (e) {
        if (e instanceof ConflictError) {
          serverV = e.currentVersion;
          continue;
        }
        throw e;
      }
    }
  }

  return { local, state, conflicts };
}
