import {
  createAccount,
  startLogin,
  completeLogin,
  adkToBase64,
  adkFromBase64,
  recoverWithKey,
  rewrapForNewPassword,
  recoveryAuthHashFromKey,
  regenerateRecoveryKey,
  encryptBlob,
  ownerTagFromAdk,
} from "./crypto";
import {
  listConflicts as listConflictsFn,
  getConflict as getConflictFn,
  restoreConflict as restoreConflictFn,
  discardConflict as discardConflictFn,
  notesPlainText,
  type ConflictMeta,
  type ConflictContent,
} from "./conflicts";
import {
  ApiError,
  ConflictError,
  PaymentRequiredError,
  UnauthorizedError,
  type AuthApi,
  type BillingApi,
  type Plan,
  type SyncApi,
} from "./api";
import { emptySyncState, syncOnce, SyncIntegrityError, type LocalData, type SyncState } from "./sync";
import { KEY_NOTES, newNotesConflictKey, type NotesValue } from "./syncTypes";
import type { SyncPersist } from "./syncStore";
import {
  emptyOwnerRecord,
  normalizeOwnerRecord,
  trimStash,
  MAX_STASHED_OWNERS,
  UNKNOWN_OWNER_TAG,
  type OwnerRecord,
} from "./syncOwner";

// "paused" = subscription inactive; writes are gated, the local app keeps working.
export type SyncStatus = "signed-out" | "idle" | "syncing" | "error" | "needs-relogin" | "paused";
export type { Plan };
export type { ConflictMeta, ConflictContent };

/** What the app exposes to the manager (current local state, no sync timestamps). */
export interface LocalSnapshot {
  tasks: LocalData["tasks"];
  notesDoc: Record<string, unknown> | null;
  settings: {
    theme: string;
    accent: string;
    spotifyEnabled: boolean;
    showTasks: boolean;
    menubarTimer: boolean;
    chime: boolean;
    chimeSound: string;
  };
}

/** What the manager hands back after a merge for the app to apply. */
export interface MergedSnapshot {
  tasks: LocalData["tasks"];
  notesDoc: Record<string, unknown> | null;
  settings: {
    theme: string;
    accent: string;
    spotifyEnabled: boolean;
    showTasks: boolean;
    menubarTimer: boolean;
    chime: boolean;
    chimeSound: string;
  };
}

/**
 * A previous account's tasks/notes, set aside on this install and still recoverable.
 *
 * Surfacing this is the whole point: the stash was invisible, so the sequence "delete
 * account → sign up again" emptied the app with no error, no notice, and no route back —
 * the entry is keyed by the owner tag of an account whose server record is gone, and
 * re-registering the same email mints a fresh ADK and therefore a different tag. The data
 * was sitting in focusbox.json the whole time, reachable only by editing JSON by hand.
 */
export interface StashedOwner {
  /** opaque owner tag; the UI never shows it, it only round-trips it back to restore/discard */
  tag: string;
  taskCount: number;
  notePreview: string;
  savedAt: number;
}

export interface SyncSnapshot {
  status: SyncStatus;
  email: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  recoveryKey: string | null;
  /** true when `recoveryKey` is a REPLACEMENT for a key the user already had, so the
   * panel can say the old one has stopped working. */
  recoveryKeyIsRotation: boolean;
  /** true once a notes conflict-copy was saved this session (surfaced as a hint). */
  hadNotesConflict: boolean;
  /** data belonging to accounts that previously used this install (see StashedOwner) */
  stashedOwners: StashedOwner[];
  /** set when THIS session's sign-in set the working data aside, so the UI can explain
   * why the app looks empty instead of leaving the user to guess. */
  dataSetAsideThisSession: boolean;
  // --- subscription (from GET /account/me) ---
  billingEnabled: boolean; // false → free/open, no billing UI
  syncEnabled: boolean; // may this account write to sync right now?
  subscriptionStatus: string; // none|trialing|active|past_due|canceled|...
  currentPeriodEnd: number | null; // epoch ms
}

/** Injectable timer seam so tests can drive debounce + offline backoff deterministically. */
export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SyncManagerDeps {
  api: SyncApi & AuthApi & BillingApi;
  now: () => number;
  persist: {
    load: () => Promise<SyncPersist | null>;
    save: (p: SyncPersist) => Promise<void>;
    clear: () => Promise<void>;
    newDeviceId: () => string;
  };
  /** Which account the local tasks/notes belong to. Survives logout on purpose — see
   * syncOwner.ts; without it a co-user's sign-in adopts the previous account's data. */
  owner: {
    load: () => Promise<OwnerRecord | null>;
    save: (r: OwnerRecord) => Promise<void>;
  };
  getLocal: () => LocalSnapshot;
  onMerged: (m: MergedSnapshot) => void;
  onChange: () => void;
  debounceMs?: number;
  scheduler?: Scheduler;
}

/** Turn the raw stash into something a person can recognize, newest first. */
function describeStash(stash: OwnerRecord["stash"]): StashedOwner[] {
  return Object.entries(stash)
    .map(([tag, s]) => ({
      tag,
      taskCount: (s.tasks ?? []).filter((t) => !t.deleted).length,
      notePreview: notesPlainText(s.notesDoc ?? null, 60),
      savedAt: s.savedAt ?? 0,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

function messageFor(e: unknown, fallback: string): string {
  if (e instanceof SyncIntegrityError) {
    // Deliberately terminal, not retried: the response was well-formed, it just can't have
    // come from an honest server holding this account's data. Logging out and back in
    // clears the local sync bookkeeping and starts over, which is the honest remedy if the
    // server really did lose data (e.g. restored from an older backup).
    return "Sync stopped — the server's reply didn't match this account's data, so nothing was changed. Log out and back in to start over.";
  }
  if (e instanceof UnauthorizedError) return "Incorrect email or password.";
  if (e instanceof ApiError && e.status === 409) return "An account with that email already exists.";
  if (e instanceof ApiError) return `Sync server error (${e.status}).`;
  if (e instanceof TypeError) return "Couldn't reach the sync server.";
  return fallback;
}

export class SyncManager {
  private d: Required<SyncManagerDeps>;

  private email: string | null = null;
  private accessToken = "";
  private refreshToken = "";
  private adk: Uint8Array | null = null;
  private deviceId = "";
  private state: SyncState = emptySyncState();
  private settingsUpdatedAt = 0;
  private notesUpdatedAt = 0;
  // Tasks have no blob-level updated_at, so we track a per-session "last local task
  // change" clock and the value captured when the current cycle's snapshot was frozen,
  // to detect a task edit that lands mid-cycle (same staleness guard as settings/notes).
  private tasksUpdatedAt = 0;
  private snapshotTasksUpdatedAt = 0;
  /** Set when a sign-in swapped the working data because it belonged to another account.
   * While it is set, getLocal() is NOT trusted for tasks/notes: the app applies onMerged
   * asynchronously, so a read could still return the previous owner's data and push it
   * into this account (the hazard restoreConflict() documents). Cleared by the first
   * user-driven local change, and kept in step with each cycle's applied result. */
  private localOverride: LocalSnapshot | null = null;

  private status: SyncStatus = "signed-out";
  private lastSyncedAt: number | null = null;
  private lastError: string | null = null;
  private recoveryKey: string | null = null;
  private recoveryKeyIsRotation = false;
  private hadNotesConflict = false;
  private stashedOwners: StashedOwner[] = [];
  private dataSetAsideThisSession = false;

  private billingEnabled = false;
  private syncEnabled = true; // assume open until /account/me says otherwise
  private subscriptionStatus = "none";
  private currentPeriodEnd: number | null = null;

  private running = false;
  private queued = false;
  private debounceTimer: unknown = null;
  private backoffHandle: unknown = null;
  private backoffMs = 0;
  private readonly backoffBaseMs = 2000;
  private readonly backoffCapMs = 60000;

  constructor(deps: SyncManagerDeps) {
    this.d = { debounceMs: 800, scheduler: defaultScheduler, ...deps };
  }

  snapshot(): SyncSnapshot {
    return {
      status: this.status,
      email: this.email,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      recoveryKey: this.recoveryKey,
      recoveryKeyIsRotation: this.recoveryKeyIsRotation,
      hadNotesConflict: this.hadNotesConflict,
      stashedOwners: this.stashedOwners,
      dataSetAsideThisSession: this.dataSetAsideThisSession,
      billingEnabled: this.billingEnabled,
      syncEnabled: this.syncEnabled,
      subscriptionStatus: this.subscriptionStatus,
      currentPeriodEnd: this.currentPeriodEnd,
    };
  }

  /** Resume a persisted session (called once on startup). */
  async init(): Promise<void> {
    const p = await this.d.persist.load();
    if (!p) {
      // No session to resume — but this is still the one moment we can establish who owns
      // the local data, and it MUST NOT be skipped. claimResumedSession() (the migration
      // backfill for installs predating the owner marker) is only reached further down,
      // on the has-a-session path. An install that signed out before upgrading therefore
      // never got backfilled on any launch, leaving its data marked "unowned" — so the
      // next account to sign in adopted it and pushed someone else's tasks and notes into
      // its own cloud blobs.
      await this.establishOwnerBaseline();
      await this.refreshStashes();
      this.status = "signed-out";
      this.emit();
      return;
    }
    this.email = p.email;
    this.accessToken = p.accessToken;
    this.refreshToken = p.refreshToken;
    this.adk = adkFromBase64(p.adk);
    this.deviceId = p.deviceId;
    this.state = p.state ?? emptySyncState();
    this.settingsUpdatedAt = p.settingsUpdatedAt ?? 0;
    this.notesUpdatedAt = p.notesUpdatedAt ?? 0;
    await this.claimResumedSession();
    await this.refreshStashes();
    this.status = "idle";
    this.emit();
    await this.refreshAccount();
    await this.syncNow();
  }

  /**
   * Write an ownership record on an install that has never had one, so "no record" stops
   * meaning two different things.
   *
   * The record's mere existence is the migration marker. Once it is written, a later
   * absence of a tag genuinely means "nobody has ever owned this data"; before it is
   * written, absence is ambiguous — it could equally be a pre-marker install whose owner
   * signed out. The two are indistinguishable on disk, so the tie is broken by whether
   * there is anything to protect:
   *
   *  - data present → UNKNOWN_OWNER_TAG. Never equal to a real tag, so no account adopts
   *    it; it is set aside intact and offered back through the stash UI in one click.
   *  - nothing present → tag stays null. A genuinely fresh install, so the first account
   *    to sign in still adopts the tasks the user types before signing up.
   *
   * Non-fatal: a failed write just leaves the pre-existing behavior for one more launch.
   */
  private async establishOwnerBaseline(): Promise<void> {
    try {
      if (normalizeOwnerRecord(await this.d.owner.load()) !== null) return; // already marked
      const local = this.d.getLocal();
      const hasData = local.tasks.length > 0 || local.notesDoc !== null;
      await this.d.owner.save({ tag: hasData ? UNKNOWN_OWNER_TAG : null, stash: {} });
    } catch (e) {
      console.error("Focusbox: couldn't record which account owns the local data.", e);
    }
  }

  async signup(emailRaw: string, password: string): Promise<void> {
    const email = emailRaw.trim().toLowerCase();
    this.status = "syncing";
    this.lastError = null;
    this.emit();
    try {
      const created = await createAccount(email, password);
      const tokens = await this.d.api.signup(email, created.signup);
      await this.claimLocalData(created.session.adk);
      this.setIdentity(email, tokens.access_token, tokens.refresh_token, created.session.adk, {
        notesUpdatedAt: this.d.now(),
        settingsUpdatedAt: this.d.now(),
      });
      this.recoveryKey = created.recoveryKey; // shown once
      this.recoveryKeyIsRotation = false;
      await this.persistBestEffort(); // resume-only; a persistent failure resurfaces in syncNow
      await this.refreshAccount(); // learn billing/sync_enabled before attempting a push
      await this.syncNow(); // push local data up (skipped if a subscription is required)
    } catch (e) {
      this.status = "error";
      this.lastError = messageFor(e, "Couldn't create the account.");
      this.emit();
      throw e;
    }
  }

  async login(emailRaw: string, password: string): Promise<void> {
    const email = emailRaw.trim().toLowerCase();
    this.status = "syncing";
    this.lastError = null;
    this.emit();
    try {
      const start = startLogin(email, password);
      const res = await this.d.api.login(email, start.auth_hash);
      const session = completeLogin(start.encKey, res.wrapped_adk);
      const local = await this.claimLocalData(session.adk);
      this.setIdentity(email, res.access_token, res.refresh_token, session.adk, {
        // Preserve local notes if any (they win/conflict-copy); otherwise adopt server.
        notesUpdatedAt: local.notesDoc ? this.d.now() : 0,
        // Prefer the account's settings on a fresh login.
        settingsUpdatedAt: 0,
      });
      await this.persistBestEffort(); // resume-only; a persistent failure resurfaces in syncNow
      await this.refreshAccount();
      await this.syncNow();
    } catch (e) {
      this.status = "error";
      this.lastError = messageFor(e, "Couldn't log in.");
      this.emit();
      throw e;
    }
  }

  async recover(emailRaw: string, recoveryKey: string, newPassword: string): Promise<void> {
    const email = emailRaw.trim().toLowerCase();
    this.status = "syncing";
    this.lastError = null;
    this.emit();
    try {
      const rah = recoveryAuthHashFromKey(recoveryKey);
      const start = await this.d.api.recoverStart(email, rah);
      const adk = await recoverWithKey(recoveryKey, start.recovery_wrapped_adk);
      const rewrapped = await rewrapForNewPassword(email, newPassword, adk);
      // Burn the key that authorized this reset. Whoever ran the flow proved they hold it,
      // so leaving it valid hands an attacker a permanent second credential — and leaves
      // the legitimate owner able only to reset the password back and forth forever.
      const nextRecovery = regenerateRecoveryKey(adk);
      const tokens = await this.d.api.recoverComplete({
        email,
        recovery_auth_hash: rah,
        new_auth_hash: rewrapped.auth_hash,
        new_wrapped_adk: rewrapped.wrapped_adk,
        kdf_params: rewrapped.kdf_params,
        new_recovery_wrapped_adk: nextRecovery.recovery_wrapped_adk,
        new_recovery_auth_hash: nextRecovery.recovery_auth_hash,
      });
      const local = await this.claimLocalData(adk);
      this.setIdentity(email, tokens.access_token, tokens.refresh_token, adk, {
        notesUpdatedAt: local.notesDoc ? this.d.now() : 0,
        settingsUpdatedAt: 0,
      });
      this.recoveryKey = nextRecovery.recoveryKey; // shown once, replaces the used one
      this.recoveryKeyIsRotation = true;
      await this.persistBestEffort();
      await this.refreshAccount();
      await this.syncNow();
    } catch (e) {
      this.status = "error";
      this.lastError =
        e instanceof UnauthorizedError
          ? "Recovery key or email is incorrect."
          : messageFor(e, "Couldn't reset your password.");
      this.emit();
      throw e;
    }
  }

  async logout(): Promise<void> {
    if (this.debounceTimer) this.d.scheduler.clear(this.debounceTimer);
    this.debounceTimer = null;
    this.clearBackoff();
    this.backoffMs = 0;
    // Clear the in-flight mutex so a cycle that completes after sign-out can't wedge or
    // mislead a later call (its own completion is guarded by the signed-out checks).
    this.running = false;
    this.queued = false;
    if (this.adk) this.adk.fill(0);
    this.adk = null;
    this.email = null;
    this.accessToken = "";
    this.refreshToken = "";
    this.deviceId = "";
    this.state = emptySyncState();
    this.settingsUpdatedAt = 0;
    this.notesUpdatedAt = 0;
    this.tasksUpdatedAt = 0;
    this.snapshotTasksUpdatedAt = 0;
    this.localOverride = null;
    // The owner record is deliberately NOT cleared: tasks/notes stay in the app after
    // sign-out, so the marker saying whose they are has to stay with them.
    this.status = "signed-out";
    this.lastError = null;
    this.recoveryKey = null;
    this.recoveryKeyIsRotation = false;
    this.hadNotesConflict = false;
    // stashedOwners is deliberately NOT cleared: the set-aside data is still on disk and
    // still restorable, so the list has to survive sign-out the same way the marker does.
    this.dataSetAsideThisSession = false;
    this.billingEnabled = false;
    this.syncEnabled = true;
    this.subscriptionStatus = "none";
    this.currentPeriodEnd = null;
    await this.d.persist.clear();
    this.emit();
  }

  dismissRecoveryKey(): void {
    this.recoveryKey = null;
    this.recoveryKeyIsRotation = false;
    this.emit();
  }

  /** Debounced trigger; call on any local change. */
  scheduleSync(): void {
    if (this.status === "signed-out") return;
    // A fresh local change resets any pending offline backoff cycle.
    this.clearBackoff();
    this.backoffMs = 0;
    if (this.debounceTimer) this.d.scheduler.clear(this.debounceTimer);
    this.debounceTimer = this.d.scheduler.set(() => {
      this.debounceTimer = null;
      void this.syncNow();
    }, this.d.debounceMs);
  }

  notifyTasksChanged(): void {
    this.tasksUpdatedAt = this.d.now();
    this.localOverride = null; // the app's state is live again: a user edit came from it
    this.scheduleSync();
  }
  notifyNotesChanged(at: number): void {
    if (at > this.notesUpdatedAt) this.notesUpdatedAt = at;
    this.localOverride = null;
    this.scheduleSync();
  }
  notifySettingsChanged(at: number): void {
    if (at > this.settingsUpdatedAt) this.settingsUpdatedAt = at;
    this.localOverride = null;
    this.scheduleSync();
  }

  async syncNow(): Promise<void> {
    if (this.status === "signed-out" || !this.adk) return;
    // Subscription inactive: writes are gated server-side, so don't hammer it — just
    // reflect the paused state. A focus/refreshAccount that flips syncEnabled re-enables.
    if (this.billingEnabled && !this.syncEnabled) {
      this.status = "paused";
      this.emit();
      return;
    }
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    this.status = "syncing";
    this.lastError = null;
    this.emit();
    try {
      do {
        this.queued = false;
        await this.runCycle();
      } while (this.queued);
      // If the user signed out (or was deleted) while this cycle was in flight, don't
      // resurrect an "idle"/synced status over the signed-out state. (Cast defeats TS's
      // literal-narrowing of the mutable status field across the awaited runCycle.)
      if ((this.status as SyncStatus) !== "signed-out" && this.adk) {
        this.status = "idle";
        this.lastSyncedAt = this.d.now();
        this.backoffMs = 0;
        this.clearBackoff();
      }
    } catch (e) {
      if ((this.status as SyncStatus) === "signed-out" || !this.adk) {
        // Signed out mid-flight: swallow — never overwrite signed-out or schedule a retry.
      } else if (e instanceof PaymentRequiredError) {
        // subscription lapsed mid-session: pause and re-confirm from /account/me
        this.syncEnabled = false;
        this.status = "paused";
        void this.refreshAccount();
      } else if (e instanceof UnauthorizedError) {
        this.status = "needs-relogin";
        this.lastError = messageFor(e, "Sync failed.");
      } else if (this.isTransient(e)) {
        // Network/5xx: keep the local app working and auto-retry with backoff.
        this.status = "error";
        this.lastError = "Offline — retrying…";
        this.scheduleBackoff();
      } else {
        this.status = "error";
        this.lastError = messageFor(e, "Sync failed.");
      }
    } finally {
      this.running = false;
      this.emit();
    }
  }

  /** A failure worth auto-retrying: a network error or a 5xx. (401/402 are terminal and
   * handled before this is reached.) */
  private isTransient(e: unknown): boolean {
    return e instanceof TypeError || (e instanceof ApiError && e.status >= 500);
  }

  private scheduleBackoff(): void {
    if (this.status === "signed-out" || !this.adk) return;
    this.clearBackoff();
    this.backoffMs =
      this.backoffMs === 0 ? this.backoffBaseMs : Math.min(this.backoffMs * 2, this.backoffCapMs);
    this.backoffHandle = this.d.scheduler.set(() => {
      this.backoffHandle = null;
      void this.syncNow();
    }, this.backoffMs);
  }

  private clearBackoff(): void {
    if (this.backoffHandle !== null) {
      this.d.scheduler.clear(this.backoffHandle);
      this.backoffHandle = null;
    }
  }

  /** Connectivity returned: cancel any pending backoff and sync now. */
  onOnline(): void {
    if (this.status === "signed-out") return;
    this.clearBackoff();
    this.backoffMs = 0;
    void this.syncNow();
  }

  /** Fetch subscription status from the server (non-fatal on failure). */
  async refreshAccount(): Promise<void> {
    if (!this.email) return;
    try {
      const acct = await this.authedCall((token) => this.d.api.getAccount(token));
      this.billingEnabled = acct.billing_enabled;
      this.syncEnabled = acct.sync_enabled;
      this.subscriptionStatus = acct.subscription_status;
      this.currentPeriodEnd = acct.current_period_end
        ? Date.parse(acct.current_period_end)
        : null;
      this.emit();
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        this.status = "needs-relogin";
        this.emit();
      } else {
        console.error("Focusbox: couldn't refresh subscription status.", e);
      }
    }
  }

  /** Create a Stripe Checkout session; returns the URL for the UI to open. */
  async startCheckout(plan: Plan): Promise<string> {
    const { url } = await this.authedCall((token) => this.d.api.createCheckout(token, plan));
    return url;
  }

  /** Create a Stripe Customer Portal session; returns the URL for the UI to open. */
  async openPortal(): Promise<string> {
    const { url } = await this.authedCall((token) => this.d.api.createPortal(token));
    return url;
  }

  /**
   * Delete the cloud account (server purges blobs + cancels the subscription), then sign
   * out. Local tasks/notes are untouched — logout() clears only the sync identity.
   *
   * They stay reachable afterwards, which is the part that used to be untrue in practice:
   * logout() leaves `owner.tag` pointing at the now-deleted account, so the next account
   * created here is a tag mismatch and the data is set aside. It is now listed and
   * restorable (see StashedOwner) instead of vanishing.
   *
   * `alsoEraseLocal` is for the other intent — "remove me from this machine entirely" —
   * and wipes the working data plus every stash.
   */
  async deleteAccount(alsoEraseLocal = false): Promise<void> {
    await this.authedCall((t) => this.d.api.deleteAccount(t));
    if (alsoEraseLocal) await this.eraseLocalData();
    await this.logout();
    await this.refreshStashes();
  }

  /**
   * Replace this account's recovery key with a fresh one (M3).
   *
   * The recovery key is a standalone account-takeover credential: it yields the raw ADK
   * and, through `recover/complete`, a password reset that locks the real owner out. It
   * was also permanently un-rotatable — the reset path writes only the password-side
   * material, so a leaked key stayed valid forever and the only terminating remedy was
   * deleting the account. This re-wraps the SAME ADK under new recovery bytes, so the old
   * key stops opening anything and no blob has to be re-encrypted.
   *
   * The new key is surfaced through `snapshot().recoveryKey` for the same show-once panel
   * as signup, with `recoveryKeyIsRotation` set so the copy can say the old one is dead.
   */
  async regenerateRecoveryKey(): Promise<void> {
    const adk = this.adk;
    if (!adk) throw new Error("locked");
    const next = regenerateRecoveryKey(adk);
    await this.authedCall((t) =>
      this.d.api.rotateRecovery(t, {
        recovery_wrapped_adk: next.recovery_wrapped_adk,
        recovery_auth_hash: next.recovery_auth_hash,
      }),
    );
    this.recoveryKey = next.recoveryKey;
    this.recoveryKeyIsRotation = true;
    this.emit();
  }

  // ---- data set aside for other accounts that used this install (M1) ----

  /** Re-read the owner record and republish the stash list to the UI. Non-fatal. */
  private async refreshStashes(): Promise<void> {
    try {
      const rec = normalizeOwnerRecord(await this.d.owner.load());
      this.stashedOwners = rec ? describeStash(rec.stash) : [];
    } catch (e) {
      console.error("Focusbox: couldn't read set-aside data.", e);
      this.stashedOwners = [];
    }
    this.emit();
  }

  /**
   * Bring a set-aside account's tasks and notes back as the working data.
   *
   * This is a deliberate, user-initiated move ACROSS accounts — after it runs, the
   * restored data belongs to whoever is signed in now and will sync to their cloud. That
   * is the point (the common case is one person who deleted their account and made a new
   * one), but it is why the UI has to say so plainly rather than calling it "undo".
   *
   * The data currently in the app is not thrown away: it goes into the stash under the
   * present owner's tag, so this is reversible in the same one click.
   */
  async restoreStash(tag: string): Promise<void> {
    const rec = normalizeOwnerRecord(await this.d.owner.load());
    const entry = rec?.stash[tag];
    if (!rec || !entry) return;
    const now = this.d.now();
    const current = this.localOverride ?? this.d.getLocal();
    const stash = { ...rec.stash };
    delete stash[tag];
    // Park what is on screen right now under whoever currently owns it, so restoring is
    // symmetrical and nothing is lost either way. `rec.tag` is null only on an install
    // that never had an owner, where there is no key to park it under.
    if (rec.tag !== null) {
      stash[rec.tag] = {
        tasks: current.tasks,
        notesDoc: current.notesDoc,
        savedAt: now,
      };
    }
    await this.d.owner.save({ tag: rec.tag, stash: trimStash(stash, MAX_STASHED_OWNERS) });

    const restored: LocalSnapshot = {
      tasks: entry.tasks,
      notesDoc: entry.notesDoc,
      settings: current.settings, // device-level; not part of the stash
    };
    // Treat the restored data as authoritative for the next cycle: onMerged is an async
    // setState in the app, so a getLocal() read before it flushes would still return the
    // data we just parked and push THAT instead.
    this.localOverride = restored;
    // Stamp both clocks forward so the restore wins LWW against the server's current
    // copy rather than being silently overwritten by it. The server's note is not lost —
    // resolveNotes keeps it as a conflict copy, listed under "Notes backups".
    this.tasksUpdatedAt = now;
    this.notesUpdatedAt = now;
    this.dataSetAsideThisSession = false;
    this.d.onMerged(restored);
    await this.refreshStashes();
    this.scheduleSync();
  }

  /** Permanently drop a set-aside account's data. */
  async discardStash(tag: string): Promise<void> {
    const rec = normalizeOwnerRecord(await this.d.owner.load());
    if (!rec || !rec.stash[tag]) return;
    const stash = { ...rec.stash };
    delete stash[tag];
    await this.d.owner.save({ tag: rec.tag, stash });
    await this.refreshStashes();
  }

  /** Erase the tasks and notes on THIS device, including everything set aside. Used by the
   * delete-account flow when the user asks for a clean slate. */
  async eraseLocalData(): Promise<void> {
    await this.d.owner.save({ tag: null, stash: {} });
    const cleared: LocalSnapshot = {
      tasks: [],
      notesDoc: null,
      settings: (this.localOverride ?? this.d.getLocal()).settings,
    };
    this.localOverride = null;
    this.dataSetAsideThisSession = false;
    this.d.onMerged(cleared);
    await this.refreshStashes();
  }

  // ---- notes conflict copies (P3b) ----

  async listConflicts(): Promise<ConflictMeta[]> {
    if (!this.email) return [];
    return this.authedCall((t) => listConflictsFn(this.d.api, t));
  }

  async getConflict(key: string): Promise<ConflictContent> {
    const adk = this.adk;
    if (!adk) throw new Error("locked");
    return this.authedCall((t) => getConflictFn(this.d.api, t, adk, key));
  }

  async discardConflict(key: string): Promise<void> {
    await this.authedCall((t) => discardConflictFn(this.d.api, t, key));
  }

  /** Restore a conflict copy as the current note (backing up the current note first).
   * Applies the restored doc into the app and pushes it as the new current note. */
  async restoreConflict(key: string): Promise<void> {
    const adk = this.adk;
    if (!adk) throw new Error("locked");
    const now = this.d.now();
    const current = this.buildLocalData().notes;
    const { notes } = await this.authedCall((t) =>
      restoreConflictFn({ api: this.d.api, token: t, adk, key, current, now }),
    );
    this.notesUpdatedAt = notes.updated_at;
    // A restore replaces the note outside the merge path, so a sign-in swap's authoritative
    // copy is now stale: keeping it would push the pre-restore doc under the restored
    // doc's timestamp on the next cycle and silently undo the restore. This path already
    // treats the app as the source of truth for everything else (it re-reads getLocal
    // below), so drop the override rather than trying to patch it.
    this.localOverride = null;
    // Push the restored doc AUTHORITATIVELY — do NOT rely on a follow-up syncNow reading
    // getLocal(), because onMerged is an async setState in the app that may not have
    // flushed yet (so getLocal() would still return the OLD note and overwrite the
    // server with it). pushNotes uses the explicit restored value instead.
    await this.pushNotes(notes);
    const local = this.d.getLocal();
    this.d.onMerged({ tasks: local.tasks, notesDoc: notes.doc, settings: local.settings });
    await this.persistIdentity();
  }

  /** Push a specific notes value to KEY_NOTES authoritatively (independent of getLocal()).
   * A concurrent-writer 409 is left for the next normal sync to reconcile via LWW. */
  private async pushNotes(note: NotesValue): Promise<void> {
    const adk = this.adk;
    if (!adk) return;
    const base = this.state.versions[KEY_NOTES] ?? 0;
    const { ciphertext, nonce } = encryptBlob(JSON.stringify(note), adk, KEY_NOTES);
    try {
      const res = await this.authedCall((t) =>
        this.d.api.pushBlob(t, {
          key: KEY_NOTES,
          ciphertext,
          nonce,
          base_version: base,
        }),
      );
      this.state.versions[KEY_NOTES] = res.version;
      this.state.notesBaseUpdatedAt = note.updated_at;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }

  /** TEST-ONLY: encrypt + push a notes conflict copy with this session's ADK so tests
   * can exercise the restore/discard path against the in-memory backend. */
  async seedConflictForTest(value: {
    doc: Record<string, unknown> | null;
    updated_at: number;
  }): Promise<string> {
    // Hard-disabled in production builds — it can't be reached from the app (not on the
    // useSync controller surface), and this guard keeps it out of the shipped behavior.
    if ((import.meta as { env?: { PROD?: boolean } }).env?.PROD) {
      throw new Error("seedConflictForTest is test-only");
    }
    const adk = this.adk;
    if (!adk) throw new Error("locked");
    const key = newNotesConflictKey();
    const { ciphertext, nonce } = encryptBlob(JSON.stringify(value), adk, key);
    await this.authedCall((t) =>
      this.d.api.pushBlob(t, { key, ciphertext, nonce, base_version: 0 }),
    );
    return key;
  }

  // ---- internals ----

  private buildLocalData(): LocalData {
    const s = this.localOverride ?? this.d.getLocal();
    // Freeze the tasks clock alongside this snapshot so applyResult can tell whether a
    // task edit landed after the snapshot but before the cycle applied its result.
    this.snapshotTasksUpdatedAt = this.tasksUpdatedAt;
    return {
      tasks: s.tasks,
      notes: { doc: s.notesDoc, updated_at: this.notesUpdatedAt },
      settings: { ...s.settings, updated_at: this.settingsUpdatedAt },
    };
  }

  /** Run an authenticated call, refreshing the access token once on a 401 and retrying.
   * A second 401 (or a failed refresh) bubbles up as UnauthorizedError -> needs-relogin. */
  private async authedCall<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(this.accessToken);
    } catch (e) {
      if (e instanceof UnauthorizedError && this.refreshToken) {
        const { access_token } = await this.d.api.refresh(this.refreshToken);
        this.accessToken = access_token;
        await this.persistBestEffort(); // new token is in-memory; resume-only on disk
        return await fn(access_token);
      }
      throw e;
    }
  }

  private async runCycle(): Promise<void> {
    if (!this.adk) return;
    const adk = this.adk;
    const res = await this.authedCall((token) =>
      syncOnce({
        api: this.d.api,
        token,
        adk,
        local: this.buildLocalData(),
        state: this.state,
        now: this.d.now(),
      }),
    );
    await this.applyResult(res);
  }

  private async applyResult(res: {
    local: LocalData;
    state: SyncState;
    conflicts: string[];
  }): Promise<void> {
    this.state = res.state;
    // A settings/notes change can land DURING a cycle whose local snapshot was already
    // frozen (e.g. the user toggles the theme while a sync is in flight). The completing
    // cycle merged from the OLD snapshot, so its result is stale for that blob: applying
    // it would revert the user's change AND roll the semantic clock backwards. Detect the
    // staleness, keep the newer timestamp, and leave that blob's UI value alone (the local
    // value the user just set stays authoritative; the already-scheduled re-sync pushes it).
    const settingsStale = res.local.settings.updated_at < this.settingsUpdatedAt;
    const notesStale = res.local.notes.updated_at < this.notesUpdatedAt;
    // A task add/delete/edit that landed during this cycle (after its snapshot froze)
    // makes the merged task list stale: applying it would revert the edit (the reported
    // "add disappears / delete comes back" bug). Keep the current local list instead; the
    // change already scheduled a re-sync that reconciles it against the server.
    const tasksStale = this.snapshotTasksUpdatedAt < this.tasksUpdatedAt;
    this.notesUpdatedAt = Math.max(this.notesUpdatedAt, res.local.notes.updated_at);
    this.settingsUpdatedAt = Math.max(this.settingsUpdatedAt, res.local.settings.updated_at);
    if (res.conflicts.length) this.hadNotesConflict = true;
    // Persist the sync metadata (versions + baselines) durably BEFORE advancing the
    // UI/local data. If the write fails it propagates to syncNow() and surfaces as a
    // sync error, instead of the UI getting ahead of a baseline that never saved.
    await this.persistIdentity();
    // While a sign-in swap is in force the app's own state may still hold the PREVIOUS
    // owner's tasks/notes (onMerged hasn't flushed), so the staleness fallback must not
    // read it back — that read is exactly how the other account's data would return.
    const cur =
      this.localOverride === null && (settingsStale || notesStale || tasksStale)
        ? this.d.getLocal()
        : null;
    const merged: MergedSnapshot = {
      tasks: tasksStale && cur ? cur.tasks : res.local.tasks,
      notesDoc: notesStale && cur ? cur.notesDoc : res.local.notes.doc,
      settings:
        settingsStale && cur
          ? cur.settings
          : {
              theme: res.local.settings.theme,
              accent: res.local.settings.accent,
              spotifyEnabled: res.local.settings.spotifyEnabled,
              showTasks: res.local.settings.showTasks,
              menubarTimer: res.local.settings.menubarTimer,
              // Older clients push a settings blob without this key; if such a blob
              // wins LWW the field arrives undefined, so fall back to the default.
              chime: res.local.settings.chime ?? false,
              chimeSound: res.local.settings.chimeSound ?? "bell",
            },
    };
    // Keep the override in step with what the app was just handed, so a follow-up cycle
    // still has an authoritative view instead of falling back to a possibly-unflushed read.
    if (this.localOverride !== null) this.localOverride = { ...merged };
    this.d.onMerged(merged);
  }

  /** A resumed session's account owns the local data by construction (it has been the
   * signed-in account all along), so just claim it. This also backfills the marker on
   * installs that predate it — without the backfill their data would still read as
   * "unowned" and the next account to sign in would adopt it. Non-fatal: a failed write
   * is retried on the next sign-in, and never blocks resuming. */
  private async claimResumedSession(): Promise<void> {
    if (!this.adk) return;
    try {
      const tag = ownerTagFromAdk(this.adk);
      const rec = normalizeOwnerRecord(await this.d.owner.load()) ?? emptyOwnerRecord();
      if (rec.tag !== tag) await this.d.owner.save({ ...rec, tag });
    } catch (e) {
      console.error("Focusbox: couldn't record which account owns the local data.", e);
    }
  }

  /**
   * Decide who the local tasks/notes belong to, before this account syncs.
   *
   * logout() leaves tasks and notes in the app on purpose, so at sign-in time they may
   * belong to a *different* account. Adopting them would push one person's private data
   * into another person's cloud blobs and overwrite their note (keeping it only as a
   * conflict copy), so on a mismatch the departing account's data is set aside verbatim —
   * never deleted, it may be unsynced and irreplaceable — and this account starts from its
   * own copy (whatever was stashed here last time) or from empty, letting the first sync
   * cycle fill it in from the server.
   *
   * Returns the working data this account actually starts with.
   */
  private async claimLocalData(adk: Uint8Array): Promise<LocalSnapshot> {
    const tag = ownerTagFromAdk(adk);
    const rec = normalizeOwnerRecord(await this.d.owner.load()) ?? emptyOwnerRecord();
    const local = this.d.getLocal();

    // Unowned (fresh install) or the same account signing back in: adopt the local data,
    // exactly as before.
    if (rec.tag === null || rec.tag === tag) {
      this.localOverride = null;
      this.dataSetAsideThisSession = false;
      await this.d.owner.save({ ...rec, tag });
      return local;
    }

    // Read this account's own stashed copy BEFORE trimming, so restoring it always wins
    // over the size cap.
    const mine = rec.stash[tag] ?? null;
    const stash = trimStash(
      {
        ...rec.stash,
        [rec.tag]: { tasks: local.tasks, notesDoc: local.notesDoc, savedAt: this.d.now() },
      },
      MAX_STASHED_OWNERS,
    );
    delete stash[tag]; // it's the working data again now, not a stash entry
    const mySnapshot: LocalSnapshot = {
      tasks: mine?.tasks ?? [],
      notesDoc: mine?.notesDoc ?? null,
      settings: local.settings, // device-level; the account's own settings win on sign-in
    };
    // Save the marker BEFORE anything is pushed: if this write fails the sign-in fails,
    // rather than syncing with an ownership record the disk doesn't agree with.
    await this.d.owner.save({ tag, stash });
    this.localOverride = mySnapshot;
    // The app is about to look empty (or to change under the user). Say so — silently
    // swapping the working data is what made this indistinguishable from data loss.
    this.dataSetAsideThisSession = local.tasks.length > 0 || local.notesDoc !== null;
    this.stashedOwners = describeStash(stash);
    this.d.onMerged(mySnapshot);
    return mySnapshot;
  }

  private setIdentity(
    email: string,
    access: string,
    refresh: string,
    adk: Uint8Array,
    times: { notesUpdatedAt: number; settingsUpdatedAt: number },
  ): void {
    this.email = email;
    this.accessToken = access;
    this.refreshToken = refresh;
    this.adk = adk;
    if (!this.deviceId) this.deviceId = this.d.persist.newDeviceId();
    this.state = emptySyncState();
    this.notesUpdatedAt = times.notesUpdatedAt;
    this.settingsUpdatedAt = times.settingsUpdatedAt;
    this.tasksUpdatedAt = 0;
    this.snapshotTasksUpdatedAt = 0;
  }

  /** Persist for cross-launch resume, tolerating failure. Used where the in-memory
   * session is already usable for this run (signup/login/token-refresh); a persistent
   * disk problem will still surface on the next sync cycle via persistIdentity(). */
  private async persistBestEffort(): Promise<void> {
    try {
      await this.persistIdentity();
    } catch (e) {
      console.error("Focusbox: could not save session locally (will retry on next sync).", e);
    }
  }

  private async persistIdentity(): Promise<void> {
    if (!this.email || !this.adk) return;
    await this.d.persist.save({
      email: this.email,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      adk: adkToBase64(this.adk),
      deviceId: this.deviceId,
      state: this.state,
      settingsUpdatedAt: this.settingsUpdatedAt,
      notesUpdatedAt: this.notesUpdatedAt,
    });
  }

  private emit(): void {
    this.d.onChange();
  }
}
