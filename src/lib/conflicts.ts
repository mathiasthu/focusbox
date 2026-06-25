import { decryptBlob, encryptBlob } from "./crypto";
import { ConflictError, type SyncApi } from "./api";
import { notesConflictKey, type NotesValue } from "./syncTypes";

const CONFLICT_PREFIX = "notes_conflict:";

/** Short random suffix to guarantee a unique backup-copy key (collision-free). */
function randomSuffix(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

export interface ConflictMeta {
  key: string;
  updatedAt: number;
  deviceId: string | null;
}

export interface ConflictContent {
  key: string;
  doc: Record<string, unknown> | null;
  updatedAt: number;
}

/** Cheap: list conflict-copy keys from the manifest (no decryption). Newest first. */
export async function listConflicts(api: SyncApi, token: string): Promise<ConflictMeta[]> {
  const manifest = await api.getManifest(token);
  return manifest
    .filter((m) => m.key.startsWith(CONFLICT_PREFIX))
    .map((m) => {
      // key shape: notes_conflict:<deviceId>-<updatedAtMs>
      const suffix = m.key.slice(CONFLICT_PREFIX.length);
      const dash = suffix.lastIndexOf("-");
      const ts = dash >= 0 ? Number(suffix.slice(dash + 1)) : NaN;
      return {
        key: m.key,
        updatedAt: Number.isFinite(ts) ? ts : Date.parse(m.updated_at) || 0,
        deviceId: dash >= 0 ? suffix.slice(0, dash) : null,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Fetch + decrypt one conflict copy. */
export async function getConflict(
  api: SyncApi,
  token: string,
  adk: Uint8Array,
  key: string,
): Promise<ConflictContent> {
  const blob = await api.getBlob(token, key);
  const value = JSON.parse(decryptBlob(blob.ciphertext, blob.nonce, adk)) as NotesValue;
  return {
    key,
    doc: value.doc ?? null,
    updatedAt: typeof value.updated_at === "number" ? value.updated_at : 0,
  };
}

/** Delete a conflict copy server-side. */
export async function discardConflict(api: SyncApi, token: string, key: string): Promise<void> {
  await api.deleteBlob(token, key);
}

export interface RestoreResult {
  notes: NotesValue;
}

/**
 * Restore a conflict copy as the current note. If the current note has content and
 * differs from the copy, it is first pushed as a fresh conflict copy (so nothing is
 * lost); then the chosen copy becomes the new current note (updated_at = now → wins
 * LWW), and the restored blob is deleted. Returns the new current note to apply locally.
 * A network failure backing up the current note aborts the restore (nothing deleted).
 */
export async function restoreConflict(opts: {
  api: SyncApi;
  token: string;
  adk: Uint8Array;
  deviceId: string;
  key: string;
  current: NotesValue;
  now: number;
}): Promise<RestoreResult> {
  const { api, token, adk, deviceId, key, current, now } = opts;
  const restored = await getConflict(api, token, adk, key);

  const hasContent = current.doc !== null;
  const differs = JSON.stringify(current.doc) !== JSON.stringify(restored.doc);
  if (hasContent && differs) {
    // Unique suffix so the backup can NEVER collide with an existing conflict blob — a
    // base_version:0 push onto an occupied key would 409 and (if we ignored it) silently
    // drop the unsynced current note. With a fresh key a 409 is unreachable; any genuine
    // failure (network) propagates and aborts BEFORE we delete the restored copy, so the
    // current note is never lost.
    const backupKey = notesConflictKey(`${deviceId}-${now}-${randomSuffix()}`);
    const { ciphertext, nonce } = encryptBlob(JSON.stringify(current), adk);
    try {
      await api.pushBlob(token, { key: backupKey, ciphertext, nonce, base_version: 0, device_id: deviceId });
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e; // defensive: a fresh key shouldn't 409
    }
  }

  await api.deleteBlob(token, key);
  return { notes: { doc: restored.doc, updated_at: now } };
}

/** First ~max chars of plain text extracted from a TipTap JSON doc (for previews). */
export function notesPlainText(doc: Record<string, unknown> | null, max = 80): string {
  if (!doc) return "";
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) + "…" : text;
}
