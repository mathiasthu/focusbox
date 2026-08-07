import { decryptBlob, encryptBlob } from "./crypto";
import { ConflictError, type SyncApi } from "./api";
import { newNotesConflictKey, type NotesValue } from "./syncTypes";

const CONFLICT_PREFIX = "notes_conflict:";

export interface ConflictMeta {
  key: string;
  updatedAt: number;
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
      // Current keys are opaque (see newNotesConflictKey), so the display timestamp comes
      // from the manifest. Keys written before v0.2.19 embedded it as
      // `notes_conflict:<deviceId>-<updatedAtMs>`; still read those so old copies keep
      // showing their real edit time.
      const suffix = m.key.slice(CONFLICT_PREFIX.length);
      const dash = suffix.lastIndexOf("-");
      const legacyTs = dash >= 0 ? Number(suffix.slice(dash + 1)) : NaN;
      return {
        key: m.key,
        updatedAt: Number.isFinite(legacyTs) ? legacyTs : Date.parse(m.updated_at) || 0,
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
  // Same framing rule as sync.pull(): the server does not get to substitute a different
  // blob for the one that was asked for.
  if (blob.key !== key) {
    throw new Error(`sync server answered "${key}" with blob "${blob.key}"`);
  }
  const value = JSON.parse(decryptBlob(blob.ciphertext, blob.nonce, adk, key)) as NotesValue;
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
  key: string;
  current: NotesValue;
  now: number;
}): Promise<RestoreResult> {
  const { api, token, adk, key, current, now } = opts;
  const restored = await getConflict(api, token, adk, key);

  const hasContent = current.doc !== null && current.doc !== undefined;
  const differs = JSON.stringify(current.doc ?? null) !== JSON.stringify(restored.doc);
  if (hasContent && differs) {
    // Fresh random key so the backup can NEVER collide with an existing conflict blob — a
    // base_version:0 push onto an occupied key would 409 and (if we ignored it) silently
    // drop the unsynced current note. With a fresh key a 409 is unreachable; any genuine
    // failure (network) propagates and aborts BEFORE we delete the restored copy, so the
    // current note is never lost.
    const backupKey = newNotesConflictKey();
    const { ciphertext, nonce } = encryptBlob(JSON.stringify(current), adk, backupKey);
    try {
      await api.pushBlob(token, { key: backupKey, ciphertext, nonce, base_version: 0 });
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
