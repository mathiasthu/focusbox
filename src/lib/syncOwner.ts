import { getStore, isTauri } from "./store";
import type { SyncedTask } from "./syncTypes";

/**
 * Which cloud account the local app data belongs to, and any data set aside for other
 * accounts that have used this install.
 *
 * Why this is separate from `SyncPersist`: logout() clears the sync identity but
 * deliberately leaves tasks/notes in the app, so the ownership marker must OUTLIVE the
 * session — otherwise the next account to sign in would find "unowned" data and adopt
 * (and push) the previous account's tasks and notes into its own cloud blobs.
 *
 * `tag` is derived from the account's ADK (see ownerTagFromAdk), so this record never
 * stores an email and can't be brute-forced back to an identity.
 *
 * The stash holds a departing account's tasks/notes verbatim rather than deleting them:
 * a co-user signing in must never destroy work the other person hasn't synced. It is
 * plaintext on disk — no worse than the working data it was taken from, which already
 * sits in the same store.
 */
export interface OwnerStash {
  tasks: SyncedTask[];
  notesDoc: Record<string, unknown> | null;
  savedAt: number;
}

export interface OwnerRecord {
  /** owner tag of the account the CURRENT working tasks/notes belong to (null = unowned) */
  tag: string | null;
  /** owner tag → that account's set-aside working data */
  stash: Record<string, OwnerStash>;
}

/** How many departed accounts keep a stash before the oldest is dropped. */
export const MAX_STASHED_OWNERS = 4;

const STORE_KEY = "syncOwner"; // Tauri plugin-store key (in focusbox.json)
const LS_KEY = "focusbox-sync-owner"; // browser fallback

export function emptyOwnerRecord(): OwnerRecord {
  return { tag: null, stash: {} };
}

/** Keep the `max` most recently stashed owners, dropping the oldest. */
export function trimStash(
  stash: Record<string, OwnerStash>,
  max: number,
): Record<string, OwnerStash> {
  const entries = Object.entries(stash);
  if (entries.length <= max) return stash;
  entries.sort((a, b) => b[1].savedAt - a[1].savedAt);
  return Object.fromEntries(entries.slice(0, max));
}

/** Stands in for "someone owns this data, but the record doesn't say who". Never equal to
 * a real tag (those are base64 digests), so it always reads as a different account. */
export const UNKNOWN_OWNER_TAG = "unknown-owner";

/**
 * Coerce a stored record into a usable shape. A record that is present but malformed must
 * NOT degrade into `tag: null` ("nobody owns this"), because that is precisely what lets
 * the next account adopt — and push — someone else's tasks and notes. It becomes an
 * unknown owner instead: the data is set aside intact and no account adopts it.
 */
export function normalizeOwnerRecord(raw: unknown): OwnerRecord | null {
  if (raw === null || raw === undefined) return null; // genuinely never written
  if (typeof raw !== "object") return { tag: UNKNOWN_OWNER_TAG, stash: {} };
  const r = raw as Partial<OwnerRecord>;
  const stash =
    r.stash !== null && typeof r.stash === "object"
      ? (r.stash as Record<string, OwnerStash>)
      : {};
  if (typeof r.tag !== "string" && r.tag !== null) return { tag: UNKNOWN_OWNER_TAG, stash };
  return { tag: r.tag, stash };
}

/** Deliberately does NOT swallow read errors: silently reporting "no owner" on a failed
 * read would let the next sign-in adopt whatever data is lying around. The caller fails
 * the sign-in instead, and the user can retry. */
export async function loadOwner(): Promise<OwnerRecord | null> {
  if (isTauri) {
    const store = await getStore();
    return normalizeOwnerRecord(await store.get<unknown>(STORE_KEY));
  }
  const raw = localStorage.getItem(LS_KEY);
  return normalizeOwnerRecord(raw ? JSON.parse(raw) : null);
}

export async function saveOwner(r: OwnerRecord): Promise<void> {
  // Does NOT swallow errors: if the marker can't be written, the caller must not treat
  // the local data as claimed — a lost marker is what re-opens the cross-account leak.
  if (isTauri) {
    const store = await getStore();
    await store.set(STORE_KEY, r);
    await store.save();
    return;
  }
  localStorage.setItem(LS_KEY, JSON.stringify(r));
}
