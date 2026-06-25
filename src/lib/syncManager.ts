import {
  createAccount,
  startLogin,
  completeLogin,
  adkToBase64,
  adkFromBase64,
} from "./crypto";
import {
  ApiError,
  PaymentRequiredError,
  UnauthorizedError,
  type AuthApi,
  type BillingApi,
  type Plan,
  type SyncApi,
} from "./api";
import { emptySyncState, syncOnce, type LocalData, type SyncState } from "./sync";
import type { SyncPersist } from "./syncStore";

// "paused" = subscription inactive; writes are gated, the local app keeps working.
export type SyncStatus = "signed-out" | "idle" | "syncing" | "error" | "needs-relogin" | "paused";
export type { Plan };

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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SyncManagerDeps) {
    this.d = { debounceMs: 800, ...deps };
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

  async logout(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
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
      this.status = "idle";
      this.lastSyncedAt = this.d.now();
    } catch (e) {
      if (e instanceof PaymentRequiredError) {
        // subscription lapsed mid-session: pause and re-confirm from /account/me
        this.syncEnabled = false;
        this.status = "paused";
        void this.refreshAccount();
      } else if (e instanceof UnauthorizedError) {
        this.status = "needs-relogin";
        this.lastError = messageFor(e, "Sync failed.");
      } else {
        this.status = "error";
        this.lastError = messageFor(e, "Sync failed.");
      }
    } finally {
      this.running = false;
      this.emit();
    }
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
    this.notesUpdatedAt = res.local.notes.updated_at;
    this.settingsUpdatedAt = res.local.settings.updated_at;
    if (res.conflicts.length) this.hadNotesConflict = true;
    // Persist the sync metadata (versions + baselines) durably BEFORE advancing the
    // UI/local data. If the write fails it propagates to syncNow() and surfaces as a
    // sync error, instead of the UI getting ahead of a baseline that never saved.
    await this.persistIdentity();
    this.d.onMerged({
      tasks: res.local.tasks,
      notesDoc: res.local.notes.doc,
      settings: {
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
