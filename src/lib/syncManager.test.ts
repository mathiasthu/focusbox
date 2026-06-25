import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto } from "./crypto";
import {
  ApiError,
  ConflictError,
  PaymentRequiredError,
  UnauthorizedError,
  type AccountInfo,
  type AuthApi,
  type BillingApi,
  type BlobData,
  type LoginResult,
  type ManifestEntry,
  type Plan,
  type PushBody,
  type PushResult,
  type SignupBody,
  type SyncApi,
  type Tokens,
} from "./api";
import {
  SyncManager,
  type LocalSnapshot,
  type MergedSnapshot,
} from "./syncManager";
import type { SyncPersist } from "./syncStore";
import type { SyncedTask } from "./syncTypes";

// A single shared backend implementing auth + per-user encrypted blob storage,
// mirroring the real server's optimistic-concurrency semantics.
class FakeBackend implements SyncApi, AuthApi, BillingApi {
  users = new Map<
    string,
    { auth_hash: string; wrapped_adk: string; recovery_wrapped_adk: string; kdf_params: unknown }
  >();
  blobs = new Map<string, Map<string, { ciphertext: string; nonce: string; version: number }>>();
  private n = 0;
  failAuthOnce = false;
  breakRefresh = false;
  // billing gate: when billingEnabled && !syncAllowed, pushes 402 and /account/me
  // reports sync_enabled=false (mirrors the real server's gating).
  billingEnabled = false;
  syncAllowed = true;
  subscriptionStatus = "none";

  private mk(kind: string, email: string): string {
    return `${kind}:${email}:${this.n++}`;
  }
  private auth(token: string): string {
    if (this.failAuthOnce) {
      this.failAuthOnce = false;
      throw new UnauthorizedError();
    }
    const [kind, email] = token.split(":");
    if (kind !== "access" || !email || !this.users.has(email)) throw new UnauthorizedError();
    return email;
  }
  private bf(email: string) {
    let m = this.blobs.get(email);
    if (!m) {
      m = new Map();
      this.blobs.set(email, m);
    }
    return m;
  }

  async signup(email: string, body: Omit<SignupBody, "email">): Promise<Tokens> {
    if (this.users.has(email)) throw new ApiError(409, "exists");
    this.users.set(email, {
      auth_hash: body.auth_hash,
      wrapped_adk: body.wrapped_adk,
      recovery_wrapped_adk: body.recovery_wrapped_adk,
      kdf_params: body.kdf_params,
    });
    return { access_token: this.mk("access", email), refresh_token: this.mk("refresh", email), token_type: "bearer" };
  }
  async login(email: string, authHash: string): Promise<LoginResult> {
    const u = this.users.get(email);
    if (!u || u.auth_hash !== authHash) throw new UnauthorizedError();
    return {
      access_token: this.mk("access", email),
      refresh_token: this.mk("refresh", email),
      token_type: "bearer",
      wrapped_adk: u.wrapped_adk,
      recovery_wrapped_adk: u.recovery_wrapped_adk,
      kdf_params: u.kdf_params as LoginResult["kdf_params"],
    };
  }
  async refresh(refreshToken: string): Promise<{ access_token: string }> {
    if (this.breakRefresh) throw new UnauthorizedError();
    const [kind, email] = refreshToken.split(":");
    if (kind !== "refresh" || !this.users.has(email)) throw new UnauthorizedError();
    return { access_token: this.mk("access", email) };
  }
  async getManifest(token: string): Promise<ManifestEntry[]> {
    const email = this.auth(token);
    return [...this.bf(email).entries()].map(([key, b]) => ({
      key,
      version: b.version,
      updated_at: String(b.version),
    }));
  }
  async getBlob(token: string, key: string): Promise<BlobData> {
    const email = this.auth(token);
    const b = this.bf(email).get(key);
    if (!b) throw new ApiError(404, "not found");
    return { key, ciphertext: b.ciphertext, nonce: b.nonce, version: b.version, updated_at: String(b.version) };
  }
  async pushBlob(token: string, body: PushBody): Promise<PushResult> {
    const email = this.auth(token);
    if (this.billingEnabled && !this.syncAllowed) throw new PaymentRequiredError();
    const m = this.bf(email);
    const base = body.base_version ?? 0;
    const cur = m.get(body.key);
    if (!cur) {
      if (base !== 0) throw new ConflictError(0);
      m.set(body.key, { ciphertext: body.ciphertext, nonce: body.nonce, version: 1 });
      return { key: body.key, version: 1 };
    }
    if (base !== cur.version) throw new ConflictError(cur.version);
    cur.version += 1;
    cur.ciphertext = body.ciphertext;
    cur.nonce = body.nonce;
    return { key: body.key, version: cur.version };
  }
  async deleteBlob(token: string, key: string): Promise<void> {
    const email = this.auth(token);
    this.bf(email).delete(key);
  }
  async getAccount(token: string): Promise<AccountInfo> {
    const email = this.auth(token);
    return {
      email,
      billing_enabled: this.billingEnabled,
      sync_enabled: this.billingEnabled ? this.syncAllowed : true,
      subscription_status: this.subscriptionStatus,
      current_period_end: null,
    };
  }
  async createCheckout(token: string, plan: Plan): Promise<{ url: string }> {
    this.auth(token);
    return { url: `https://checkout.stripe.com/c/${plan}` };
  }
  async createPortal(token: string): Promise<{ url: string }> {
    this.auth(token);
    return { url: "https://billing.stripe.com/p/test" };
  }
  conflictKeys(email: string): string[] {
    return [...this.bf(email).keys()].filter((k) => k.startsWith("notes_conflict:"));
  }
}

let clock = 1000;
const now = () => ++clock;

interface Device {
  mgr: SyncManager;
  local: LocalSnapshot;
  persist: { value: SyncPersist | null };
  ctl: { failSave: boolean };
}

function makeDevice(api: FakeBackend, name: string, local?: Partial<LocalSnapshot>): Device {
  const state: LocalSnapshot = {
    tasks: [],
    notesDoc: null,
    settings: { theme: "system", accent: "clay", spotifyEnabled: true },
    ...local,
  };
  const persist = { value: null as SyncPersist | null };
  const ctl = { failSave: false };
  const mgr = new SyncManager({
    api,
    now,
    debounceMs: 0,
    persist: {
      load: async () => persist.value,
      save: async (p) => {
        if (ctl.failSave) throw new Error("disk full");
        persist.value = p;
      },
      clear: async () => {
        persist.value = null;
      },
      newDeviceId: () => `dev-${name}`,
    },
    getLocal: () => state,
    onMerged: (m: MergedSnapshot) => {
      state.tasks = m.tasks;
      state.notesDoc = m.notesDoc;
      state.settings = m.settings;
    },
    onChange: () => {},
  });
  return { mgr, local: state, persist, ctl };
}

const task = (id: string, over: Partial<SyncedTask> = {}): SyncedTask => ({
  id,
  text: id,
  done: false,
  order: 0,
  updated_at: now(),
  ...over,
});

beforeAll(async () => {
  await initCrypto();
});

describe("SyncManager", () => {
  it("signup pushes local tasks; a second device login adopts them with NO conflict copy", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A", { tasks: [task("t1")], notesDoc: { v: "hello" } });
    await a.mgr.signup("User@Example.com", "pw");
    expect(a.mgr.snapshot().status).toBe("idle");
    expect(a.mgr.snapshot().recoveryKey).toBeTypeOf("string"); // shown once
    expect(a.persist.value).not.toBeNull(); // session persisted

    const b = makeDevice(api, "B");
    await b.mgr.login("user@example.com", "pw");
    expect(b.mgr.snapshot().status).toBe("idle");
    expect(b.local.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(b.local.notesDoc).toEqual({ v: "hello" });
    expect(api.conflictKeys("user@example.com")).toHaveLength(0); // null-doc guard worked
  });

  it("propagates a task created on device B back to device A", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A");
    await a.mgr.signup("two@e.com", "pw");
    const b = makeDevice(api, "B");
    await b.mgr.login("two@e.com", "pw");

    b.local.tasks = [task("fromB")];
    b.mgr.notifyTasksChanged();
    await b.mgr.syncNow();
    await a.mgr.syncNow();
    expect(a.local.tasks.map((t) => t.id)).toContain("fromB");
  });

  it("recovers from a 401 by refreshing the access token and retrying", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A", { tasks: [task("t1")] });
    await a.mgr.signup("r@e.com", "pw");
    api.failAuthOnce = true; // next sync's first call 401s
    await a.mgr.syncNow();
    expect(a.mgr.snapshot().status).toBe("idle");
    expect(a.mgr.snapshot().lastError).toBeNull();
  });

  it("goes to needs-relogin when the refresh also fails", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A");
    await a.mgr.signup("nr@e.com", "pw");
    api.failAuthOnce = true;
    api.breakRefresh = true;
    await a.mgr.syncNow();
    expect(a.mgr.snapshot().status).toBe("needs-relogin");
  });

  it("logout clears the persisted session and returns to signed-out", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A");
    await a.mgr.signup("out@e.com", "pw");
    expect(a.persist.value).not.toBeNull();
    await a.mgr.logout();
    expect(a.mgr.snapshot().status).toBe("signed-out");
    expect(a.mgr.snapshot().email).toBeNull();
    expect(a.persist.value).toBeNull();
  });

  it("surfaces a friendly error for a duplicate signup", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A");
    await a.mgr.signup("dup@e.com", "pw");
    const b = makeDevice(api, "B");
    await expect(b.mgr.signup("dup@e.com", "pw")).rejects.toThrow();
    expect(b.mgr.snapshot().lastError).toMatch(/already exists/i);
  });

  it("surfaces a sync error when local persistence fails (not a false 'synced')", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A", { tasks: [task("t1")] });
    a.ctl.failSave = true; // make the on-disk write fail: a sync cycle must NOT report success
    await a.mgr.signup("persistfail@e.com", "pw");
    expect(a.mgr.snapshot().status).toBe("error");
    expect(a.mgr.snapshot().lastError).toBeTruthy();
  });

  it("pauses (does not push) when the subscription is inactive, then resumes once active", async () => {
    const api = new FakeBackend();
    api.billingEnabled = true;
    api.syncAllowed = false; // no active subscription yet
    const a = makeDevice(api, "A", { tasks: [task("t1")] });
    await a.mgr.signup("pause@e.com", "pw");
    expect(a.mgr.snapshot().status).toBe("paused");
    expect(a.mgr.snapshot().billingEnabled).toBe(true);
    expect(a.mgr.snapshot().syncEnabled).toBe(false);
    expect(api.blobs.get("pause@e.com")?.get("tasks")).toBeUndefined(); // nothing pushed

    // subscription becomes active; a refresh + sync now pushes
    api.syncAllowed = true;
    await a.mgr.refreshAccount();
    await a.mgr.syncNow();
    expect(a.mgr.snapshot().status).toBe("idle");
    expect(api.blobs.get("pause@e.com")?.get("tasks")).toBeDefined();
  });

  it("transitions to paused if a push is rejected mid-session (402)", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A", { tasks: [task("t1")] });
    await a.mgr.signup("lapse@e.com", "pw"); // billing off at signup -> idle
    expect(a.mgr.snapshot().status).toBe("idle");
    // subscription lapses
    api.billingEnabled = true;
    api.syncAllowed = false;
    a.local.tasks = [...a.local.tasks, task("t2")];
    a.mgr.notifyTasksChanged();
    await a.mgr.syncNow();
    expect(a.mgr.snapshot().status).toBe("paused");
    expect(a.mgr.snapshot().syncEnabled).toBe(false);
  });

  it("startCheckout and openPortal return Stripe URLs", async () => {
    const api = new FakeBackend();
    api.billingEnabled = true;
    const a = makeDevice(api, "A");
    await a.mgr.signup("buy@e.com", "pw");
    expect(await a.mgr.startCheckout("monthly")).toMatch(/checkout\.stripe\.com/);
    expect(await a.mgr.openPortal()).toMatch(/billing\.stripe\.com/);
  });

  it("surfaces a friendly error for a wrong-password login", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A");
    await a.mgr.signup("wp@e.com", "right");
    const b = makeDevice(api, "B");
    await expect(b.mgr.login("wp@e.com", "wrong")).rejects.toThrow();
    expect(b.mgr.snapshot().lastError).toMatch(/incorrect/i);
  });
});
