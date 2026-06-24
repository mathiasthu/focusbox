import { decryptBlob, encryptBlob } from "./crypto";
import { mergeSettings, mergeTasks, resolveNotes } from "./merge";
import {
  KEY_NOTES,
  KEY_SETTINGS,
  KEY_TASKS,
  notesConflictKey,
  type NotesValue,
  type SettingsValue,
  type SyncedTask,
  type TasksBlob,
} from "./syncTypes";
import { ConflictError, type SyncApi } from "./api";

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

function stableEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Coerce a numeric field to a finite number (defends the merge from a NaN/garbage
 * value in a remote blob — blobs are authenticated, so this only guards client bugs). */
function finite(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function normalizeTask(t: SyncedTask): SyncedTask {
  return { ...t, updated_at: finite(t.updated_at, 0), order: finite(t.order, 0) };
}

async function pull<T>(
  api: SyncApi,
  token: string,
  adk: Uint8Array,
  key: string,
): Promise<{ value: T; version: number }> {
  const blob = await api.getBlob(token, key);
  const plain = decryptBlob(blob.ciphertext, blob.nonce, adk);
  return { value: JSON.parse(plain) as T, version: blob.version };
}

async function pushValue(
  api: SyncApi,
  token: string,
  adk: Uint8Array,
  key: string,
  value: unknown,
  baseVersion: number,
  deviceId: string,
): Promise<number> {
  const { ciphertext, nonce } = encryptBlob(JSON.stringify(value), adk);
  const res = await api.pushBlob(token, {
    key,
    ciphertext,
    nonce,
    base_version: baseVersion,
    device_id: deviceId,
  });
  return res.version;
}

/** Sync one full cycle: pull changed blobs, merge, push local contributions. */
export async function syncOnce(opts: {
  api: SyncApi;
  token: string;
  adk: Uint8Array;
  local: LocalData;
  state: SyncState;
  deviceId: string;
}): Promise<SyncResult> {
  const { api, token, adk, deviceId } = opts;
  const local: LocalData = { ...opts.local };
  const state: SyncState = {
    versions: { ...opts.state.versions },
    notesBaseUpdatedAt: opts.state.notesBaseUpdatedAt,
  };
  const conflicts: string[] = [];

  const manifest = await api.getManifest(token);
  const mv = new Map(manifest.map((m) => [m.key, m.version]));

  // ---- tasks: per-item LWW union ----
  {
    let serverV = mv.get(KEY_TASKS) ?? 0;
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      let remote: SyncedTask[] = [];
      let baseV = 0;
      if (serverV > 0) {
        const pr = await pull<TasksBlob>(api, token, adk, KEY_TASKS);
        remote = (pr.value.items ?? []).map(normalizeTask);
        baseV = pr.version;
      }
      const merged = mergeTasks(local.tasks, remote);
      if (serverV > 0 && stableEq(merged, remote)) {
        local.tasks = merged;
        state.versions[KEY_TASKS] = serverV;
        break;
      }
      try {
        const v = await pushValue(api, token, adk, KEY_TASKS, { items: merged } as TasksBlob, baseV, deviceId);
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
    let serverV = mv.get(KEY_SETTINGS) ?? 0;
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      let remote: SettingsValue | null = null;
      let baseV = 0;
      if (serverV > 0) {
        const pr = await pull<SettingsValue>(api, token, adk, KEY_SETTINGS);
        remote = { ...pr.value, updated_at: finite(pr.value.updated_at, 0) };
        baseV = pr.version;
      }
      const merged = remote ? mergeSettings(local.settings, remote) : local.settings;
      if (serverV > 0 && stableEq(merged, remote)) {
        local.settings = merged;
        state.versions[KEY_SETTINGS] = serverV;
        break;
      }
      try {
        const v = await pushValue(api, token, adk, KEY_SETTINGS, merged, baseV, deviceId);
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
    let serverV = mv.get(KEY_NOTES) ?? 0;
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      let remote: NotesValue | null = null;
      let baseV = 0;
      if (serverV > 0) {
        const pr = await pull<NotesValue>(api, token, adk, KEY_NOTES);
        remote = { ...pr.value, updated_at: finite(pr.value.updated_at, 0) };
        baseV = pr.version;
      }
      if (!remote) {
        // No server notes yet: establish it from local.
        const v = await pushValue(api, token, adk, KEY_NOTES, local.notes, 0, deviceId);
        state.versions[KEY_NOTES] = v;
        state.notesBaseUpdatedAt = local.notes.updated_at;
        break;
      }
      const res = resolveNotes(local.notes, remote, state.notesBaseUpdatedAt);
      if (res.conflict) {
        const ckey = notesConflictKey(`${deviceId}-${res.conflict.updated_at}`);
        // best-effort: a colliding conflict key (already present) is harmless
        try {
          await pushValue(api, token, adk, ckey, res.conflict, 0, deviceId);
          conflicts.push(ckey);
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
        }
      }
      if (stableEq(res.current, remote)) {
        local.notes = res.current;
        state.versions[KEY_NOTES] = serverV;
        state.notesBaseUpdatedAt = res.current.updated_at;
        break;
      }
      try {
        const v = await pushValue(api, token, adk, KEY_NOTES, res.current, baseV, deviceId);
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
