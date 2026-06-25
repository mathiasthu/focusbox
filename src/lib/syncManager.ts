import {
  createAccount,
  startLogin,
  completeLogin,
  adkToBase64,
  adkFromBase64,
  recoverWithKey,
  rewrapForNewPassword,
  recoveryAuthHashFromKey,
  encryptBlob,
} from "./crypto";
import {
  listConflicts as listConflictsFn,
  getConflict as getConflictFn,
  restoreConflict as restoreConflictFn,
  discardConflict as discardConflictFn,
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
import { emptySyncState, syncOnce, type LocalData, type SyncState } from "./sync";
import { KEY_NOTES, type NotesValue } from "./syncTypes";
import type { SyncPersist } from "./syncStore";

// "paused" = subscription inactive; writes are gated, the local app keeps working.
export type SyncStatus = "signed-out" | "idle" | "syncing" | "error" | "needs-relogin" | "paused";
export type { Plan };
export type { ConflictMeta, ConflictContent };

/** What the app exposes to the manager (current local state, no sync timestamps). */
export interface LocalSnapshot {
  tasks: LocalData["tasks"];
  notesDoc: Record<string, unknown> | null;
  settings: { theme: string; accent: string; spotifyEnabled: boolean };
}

/** What the manager hands back after a merge for the app to apply. */
export interface MergedSnapshot {
  tasks: LocalData["tasks"];
  notesDoc: Record<string, unknown> | null;
  settings: { theme: string; accent: string; spotifyEnabled: boolean };
}

export interface SyncSnapshot {
  status: SyncStatus;
  email: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  recoveryKey: string | null;
  /** true once a notes conflict-copy was saved this session (surfaced as a hint). */
  hadNotesConflict: boolean;
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
  getLocal: () => LocalSnapshot;
  onMerged: (m: MergedSnapshot) => void;
  onChange: () => void;
  debounceMs?: number;
  scheduler?: Scheduler;
}

function messageFor(e: unknown, fallback: string): string {
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

  private status: SyncStatus = "signed-out";
  private lastSyncedAt: number | null = null;
  private lastError: string | null = null;
  private recoveryKey: string | null = null;
  private hadNotesConflict = false;

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
      hadNotesConflict: this.hadNotesConflict,
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
    this.status = "idle";
    this.emit();
    await this.refreshAccount();
    await this.syncNow();
  }

  async signup(emailRaw: string, password: string): Promise<void> {
    const email = emailRaw.trim().toLowerCase();
    this.status = "syncing";
    this.lastError = null;
    this.emit();
    try {
      const created = await createAccount(email, password);
      const tokens = await this.d.api.signup(email, created.signup);
      this.setIdentity(email, tokens.access_token, tokens.refresh_token, created.session.adk, {
        notesUpdatedAt: this.d.now(),
        settingsUpdatedAt: this.d.now(),
      });
      this.recoveryKey = created.recoveryKey; // shown once
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
      const local = this.d.getLocal();
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
      const tokens = await this.d.api.recoverComplete({
        email,
        recovery_auth_hash: rah,
        new_auth_hash: rewrapped.auth_hash,
        new_wrapped_adk: rewrapped.wrapped_adk,
        kdf_params: rewrapped.kdf_params,
      });
      const local = this.d.getLocal();
      this.setIdentity(email, tokens.access_token, tokens.refresh_token, adk, {
        notesUpdatedAt: local.notesDoc ? this.d.now() : 0,
        settingsUpdatedAt: 0,
      });
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
    this.status = "signed-out";
    this.lastError = null;
    this.recoveryKey = null;
    this.hadNotesConflict = false;
    this.billingEnabled = false;
    this.syncEnabled = true;
    this.subscriptionStatus = "none";
    this.currentPeriodEnd = null;
    await this.d.persist.clear();
    this.emit();
  }

  dismissRecoveryKey(): void {
    this.recoveryKey = null;
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
    this.scheduleSync();
  }
  notifyNotesChanged(at: number): void {
    if (at > this.notesUpdatedAt) this.notesUpdatedAt = at;
    this.scheduleSync();
  }
  notifySettingsChanged(at: number): void {
    if (at > this.settingsUpdatedAt) this.settingsUpdatedAt = at;
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

  /** Delete the cloud account (server purges blobs + cancels the subscription), then sign
   * out. Local tasks/notes are untouched — logout() clears only the sync identity. */
  async deleteAccount(): Promise<void> {
    await this.authedCall((t) => this.d.api.deleteAccount(t));
    await this.logout();
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
      restoreConflictFn({ api: this.d.api, token: t, adk, deviceId: this.deviceId, key, current, now }),
    );
    this.notesUpdatedAt = notes.updated_at;
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
    const { ciphertext, nonce } = encryptBlob(JSON.stringify(note), adk);
    try {
      const res = await this.authedCall((t) =>
        this.d.api.pushBlob(t, {
          key: KEY_NOTES,
          ciphertext,
          nonce,
          base_version: base,
          device_id: this.deviceId,
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
    const key = `notes_conflict:${this.deviceId}-${value.updated_at}`;
    const { ciphertext, nonce } = encryptBlob(JSON.stringify(value), adk);
    await this.authedCall((t) =>
      this.d.api.pushBlob(t, { key, ciphertext, nonce, base_version: 0, device_id: this.deviceId }),
    );
    return key;
  }

  // ---- internals ----

  private buildLocalData(): LocalData {
    const s = this.d.getLocal();
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
        deviceId: this.deviceId,
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
    this.notesUpdatedAt = Math.max(this.notesUpdatedAt, res.local.notes.updated_at);
    this.settingsUpdatedAt = Math.max(this.settingsUpdatedAt, res.local.settings.updated_at);
    if (res.conflicts.length) this.hadNotesConflict = true;
    // Persist the sync metadata (versions + baselines) durably BEFORE advancing the
    // UI/local data. If the write fails it propagates to syncNow() and surfaces as a
    // sync error, instead of the UI getting ahead of a baseline that never saved.
    await this.persistIdentity();
    const cur = settingsStale || notesStale ? this.d.getLocal() : null;
    this.d.onMerged({
      tasks: res.local.tasks,
      notesDoc: notesStale ? cur!.notesDoc : res.local.notes.doc,
      settings: settingsStale
        ? cur!.settings
        : {
            theme: res.local.settings.theme,
            accent: res.local.settings.accent,
            spotifyEnabled: res.local.settings.spotifyEnabled,
          },
    });
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
