import { beforeAll, describe, expect, it } from "vitest";
import { createAccount, initCrypto } from "./crypto";
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
    {
      auth_hash: string;
      wrapped_adk: string;
      recovery_wrapped_adk: string;
      recovery_auth_hash: string;
      kdf_params: unknown;
    }
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
  transientFail = 0; // when > 0, getManifest throws a network error and decrements
  gate: Promise<void> | null = null; // when set, getManifest blocks on it (simulate in-flight)

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
      recovery_auth_hash: body.recovery_auth_hash,
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
  async recoverStart(email: string, recoveryAuthHash: string) {
    const u = this.users.get(email);
    if (!u || u.recovery_auth_hash !== recoveryAuthHash) throw new UnauthorizedError();
    return { recovery_wrapped_adk: u.recovery_wrapped_adk, kdf_params: u.kdf_params as LoginResult["kdf_params"] };
  }
  async recoverComplete(body: {
    email: string;
    recovery_auth_hash: string;
    new_auth_hash: string;
    new_wrapped_adk: string;
    kdf_params: unknown;
  }): Promise<Tokens> {
    const u = this.users.get(body.email);
    if (!u || u.recovery_auth_hash !== body.recovery_auth_hash) throw new UnauthorizedError();
    u.auth_hash = body.new_auth_hash;
    u.wrapped_adk = body.new_wrapped_adk;
    u.kdf_params = body.kdf_params;
    return { access_token: this.mk("access", body.email), refresh_token: this.mk("refresh", body.email), token_type: "bearer" };
  }
  async getManifest(token: string): Promise<ManifestEntry[]> {
    if (this.gate) await this.gate;
    if (this.transientFail > 0) {
      this.transientFail--;
      throw new TypeError("network down");
    }
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
  async deleteAccount(token: string): Promise<void> {
    const email = this.auth(token);
    this.users.delete(email);
    this.blobs.delete(email);
  }
  conflictKeys(email: string): string[] {
    return [...this.bf(email).keys()].filter((k) => k.startsWith("notes_conflict:"));
  }
}

let clock = 1000;
const now = () => ++clock;

function makeFakeScheduler() {
  const tasks: { id: number; fn: () => void; ms: number }[] = [];
  let id = 0;
  return {
    scheduler: {
      set: (fn: () => void, ms: number) => {
        const t = { id: id++, fn, ms };
        tasks.push(t);
        return t.id;
      },
      clear: (h: unknown) => {
        const i = tasks.findIndex((t) => t.id === h);
        if (i >= 0) tasks.splice(i, 1);
      },
    },
    // Fire the oldest pending timer, then flush all microtasks (so the async syncNow
    // it triggers runs to completion before we assert).
    runNext: async () => {
      const t = tasks.shift();
      if (t) t.fn();
      await new Promise((r) => setTimeout(r, 0));
    },
    pending: () => tasks.length,
    lastMs: () => (tasks.length ? tasks[tasks.length - 1].ms : null),
  };
}

/** Flush pending microtasks after a fire-and-forget (void) async call. */
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Device {
  mgr: SyncManager;
  local: LocalSnapshot;
  persist: { value: SyncPersist | null };
  ctl: { failSave: boolean };
}

function makeDevice(
  api: FakeBackend,
  name: string,
  local?: Partial<LocalSnapshot>,
  scheduler?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void },
): Device {
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
    ...(scheduler ? { scheduler } : {}),
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

  it("recovers the password with the recovery key and unlocks existing data", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A", { tasks: [task("t1")], notesDoc: { v: "secret" } });
    await a.mgr.signup("rec@e.com", "old");
    const recoveryKey = a.mgr.snapshot().recoveryKey!;

    const b = makeDevice(api, "B");
    await b.mgr.recover("rec@e.com", recoveryKey, "newpass");
    expect(b.mgr.snapshot().status).toBe("idle");
    expect(b.local.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(b.local.notesDoc).toEqual({ v: "secret" });

    const c = makeDevice(api, "C");
    await expect(c.mgr.login("rec@e.com", "old")).rejects.toThrow(); // old password dead
    const d = makeDevice(api, "D");
    await d.mgr.login("rec@e.com", "newpass"); // new password works
    expect(d.mgr.snapshot().status).toBe("idle");
  });

  it("rejects recovery with a wrong recovery key (friendly error)", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A");
    await a.mgr.signup("rk@e.com", "pw");
    const wrong = (await createAccount("other@e.com", "pw")).recoveryKey;
    const b = makeDevice(api, "B");
    await expect(b.mgr.recover("rk@e.com", wrong, "new")).rejects.toThrow();
    expect(b.mgr.snapshot().lastError).toMatch(/recovery key/i);
  });

  it("lists, restores (swap+backup), and discards notes conflict copies", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A", { notesDoc: { v: "current" } });
    await a.mgr.signup("cf@e.com", "pw");
    const ckey = await a.mgr.seedConflictForTest({ doc: { v: "older" }, updated_at: 100 });

    const list = await a.mgr.listConflicts();
    expect(list.map((c) => c.key)).toContain(ckey);

    await a.mgr.restoreConflict(ckey);
    expect(a.local.notesDoc).toEqual({ v: "older" }); // restored into the app

    const after = await a.mgr.listConflicts();
    expect(after.map((c) => c.key)).not.toContain(ckey); // restored copy removed
    expect(after).toHaveLength(1); // the previous current note was backed up
  });

  it("discards a conflict copy", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A");
    await a.mgr.signup("cf2@e.com", "pw");
    const ckey = await a.mgr.seedConflictForTest({ doc: { v: "x" }, updated_at: 5 });
    await a.mgr.discardConflict(ckey);
    expect((await a.mgr.listConflicts()).map((c) => c.key)).not.toContain(ckey);
  });

  it("restore propagates the restored doc to other devices even if getLocal lags (async setState)", async () => {
    const api = new FakeBackend();
    // Device A wired like React: getLocal() returns `committed`, which onMerged does NOT
    // update synchronously (mimics setState not flushing before the continuation). The OLD
    // code's syncNow would read the stale `committed` note and overwrite the restore.
    const committed: LocalSnapshot = {
      tasks: [],
      notesDoc: { v: "current" },
      settings: { theme: "system", accent: "clay", spotifyEnabled: true },
    };
    let applied: MergedSnapshot | null = null;
    const persist = { value: null as SyncPersist | null };
    const mgrA = new SyncManager({
      api,
      now,
      debounceMs: 0,
      persist: {
        load: async () => persist.value,
        save: async (p) => {
          persist.value = p;
        },
        clear: async () => {
          persist.value = null;
        },
        newDeviceId: () => "dev-async",
      },
      getLocal: () => committed, // never reflects the restore
      onMerged: (m) => {
        applied = m;
      },
      onChange: () => {},
    });
    await mgrA.signup("async@e.com", "pw");
    const ckey = await mgrA.seedConflictForTest({ doc: { v: "older" }, updated_at: 100 });
    await mgrA.restoreConflict(ckey);
    expect((applied as MergedSnapshot | null)?.notesDoc).toEqual({ v: "older" }); // applied into the app

    // Device B logs in fresh: the SERVER must hold the restored doc, not the stale "current".
    const b = makeDevice(api, "B");
    await b.mgr.login("async@e.com", "pw");
    expect(b.local.notesDoc).toEqual({ v: "older" });
  });

  it("deletes the account, signs out, and leaves local data intact", async () => {
    const api = new FakeBackend();
    const a = makeDevice(api, "A", { tasks: [task("keep")], notesDoc: { v: "mine" } });
    await a.mgr.signup("del@e.com", "pw");
    expect(api.users.has("del@e.com")).toBe(true);

    await a.mgr.deleteAccount();
    expect(api.users.has("del@e.com")).toBe(false); // server account gone
    expect(a.mgr.snapshot().status).toBe("signed-out");
    expect(a.persist.value).toBeNull(); // session cleared
    expect(a.local.tasks.map((t) => t.id)).toEqual(["keep"]); // local data untouched
    expect(a.local.notesDoc).toEqual({ v: "mine" });
  });

  it("retries a transient failure after backoff, then succeeds", async () => {
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(api, "A", { tasks: [task("t1")] }, fk.scheduler);
    await a.mgr.signup("off@e.com", "pw"); // first sync succeeds (transientFail=0)
    api.transientFail = 1;
    a.local.tasks = [...a.local.tasks, task("t2")];
    await a.mgr.syncNow();
    expect(a.mgr.snapshot().status).toBe("error");
    expect(a.mgr.snapshot().lastError).toMatch(/retry/i);
    expect(fk.pending()).toBe(1);
    expect(fk.lastMs()).toBe(2000);
    await fk.runNext(); // backoff fires, this time the manifest succeeds
    expect(a.mgr.snapshot().status).toBe("idle");
  });

  it("grows backoff exponentially and caps at 60s", async () => {
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(api, "A", { tasks: [task("t1")] }, fk.scheduler);
    await a.mgr.signup("cap@e.com", "pw");
    api.transientFail = 100; // always fails
    await a.mgr.syncNow();
    const seen = [fk.lastMs()];
    for (let i = 0; i < 6; i++) {
      await fk.runNext();
      seen.push(fk.lastMs());
    }
    expect(seen).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it("a successful sync resets the backoff", async () => {
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(api, "A", { tasks: [task("t1")] }, fk.scheduler);
    await a.mgr.signup("reset@e.com", "pw");
    api.transientFail = 1;
    await a.mgr.syncNow();
    expect(fk.lastMs()).toBe(2000);
    await fk.runNext(); // succeeds -> reset
    expect(a.mgr.snapshot().status).toBe("idle");
    api.transientFail = 1;
    await a.mgr.syncNow();
    expect(fk.lastMs()).toBe(2000); // base again, not 4000
  });

  it("does not auto-retry on terminal needs-relogin", async () => {
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(api, "A", { tasks: [task("t1")] }, fk.scheduler);
    await a.mgr.signup("term@e.com", "pw");
    api.failAuthOnce = true;
    api.breakRefresh = true;
    await a.mgr.syncNow();
    expect(a.mgr.snapshot().status).toBe("needs-relogin");
    expect(fk.pending()).toBe(0); // no backoff timer
  });

  it("onOnline cancels backoff and syncs immediately", async () => {
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(api, "A", { tasks: [task("t1")] }, fk.scheduler);
    await a.mgr.signup("on@e.com", "pw");
    api.transientFail = 1;
    await a.mgr.syncNow();
    expect(fk.pending()).toBe(1);
    api.transientFail = 0;
    a.mgr.onOnline();
    await flush();
    expect(fk.pending()).toBe(0); // backoff cancelled
    expect(a.mgr.snapshot().status).toBe("idle");
  });

  it("logout clears a pending backoff timer", async () => {
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(api, "A", { tasks: [task("t1")] }, fk.scheduler);
    await a.mgr.signup("lo@e.com", "pw");
    api.transientFail = 5;
    await a.mgr.syncNow();
    expect(fk.pending()).toBe(1);
    await a.mgr.logout();
    expect(fk.pending()).toBe(0);
    expect(a.mgr.snapshot().status).toBe("signed-out");
  });

  it("logout during an in-flight (then succeeding) sync stays signed-out", async () => {
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(api, "A", { tasks: [task("t1")] }, fk.scheduler);
    await a.mgr.signup("race1@e.com", "pw");
    let release!: () => void;
    api.gate = new Promise<void>((r) => (release = r));
    const p = a.mgr.syncNow(); // blocks inside getManifest
    await flush();
    await a.mgr.logout(); // sign out while the cycle is awaiting
    api.gate = null;
    release();
    await p;
    expect(a.mgr.snapshot().status).toBe("signed-out"); // not "idle"
    expect(fk.pending()).toBe(0);
  });

  it("logout during an in-flight (then failing) sync leaves no error status or orphaned backoff", async () => {
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(api, "A", { tasks: [task("t1")] }, fk.scheduler);
    await a.mgr.signup("race2@e.com", "pw");
    let release!: () => void;
    api.gate = new Promise<void>((r) => (release = r));
    api.transientFail = 1; // it will throw a transient error once the gate releases
    const p = a.mgr.syncNow();
    await flush();
    await a.mgr.logout();
    api.gate = null;
    release();
    await p;
    expect(a.mgr.snapshot().status).toBe("signed-out"); // not "error"
    expect(fk.pending()).toBe(0); // no orphaned backoff timer
  });

  it("a settings change made DURING an in-flight sync is not reverted by the completing cycle", async () => {
    // Repro of the theme-toggle revert: the user flips the theme while a sync cycle
    // (whose snapshot was frozen BEFORE the flip) is still in flight. The completing
    // cycle must NOT roll the user's choice back to the stale snapshot value.
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(
      api,
      "A",
      { settings: { theme: "dark", accent: "clay", spotifyEnabled: true } },
      fk.scheduler,
    );
    await a.mgr.signup("theme-race@e.com", "pw"); // initial push: settings(theme=dark)
    expect(a.local.settings.theme).toBe("dark");

    // Start a cycle that blocks in-flight; its snapshot is frozen at theme=dark.
    let release!: () => void;
    api.gate = new Promise<void>((r) => (release = r));
    const p = a.mgr.syncNow();
    await flush(); // reach the gated getManifest

    // User switches the theme while the cycle is in flight (mirrors changeTheme()).
    a.local.settings = { ...a.local.settings, theme: "light" };
    a.mgr.notifySettingsChanged(now());

    // Cycle completes.
    api.gate = null;
    release();
    await p;

    expect(a.local.settings.theme).toBe("light"); // the user's choice must survive
  });

  it("a task ADDED during an in-flight sync is not reverted by the completing cycle", async () => {
    // Repro of "add a task and it disappears": the user adds a task while a sync cycle
    // (snapshot frozen BEFORE the add) is in flight. The completing cycle must NOT roll
    // the list back to the stale snapshot, dropping the new task.
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(api, "A", { tasks: [task("t1")] }, fk.scheduler);
    await a.mgr.signup("task-add-race@e.com", "pw"); // initial push: tasks=[t1]
    expect(a.local.tasks.map((t) => t.id)).toEqual(["t1"]);

    // Start a cycle that blocks in-flight; its snapshot is frozen at [t1].
    let release!: () => void;
    api.gate = new Promise<void>((r) => (release = r));
    const p = a.mgr.syncNow();
    await flush(); // reach the gated getManifest

    // User adds t2 while the cycle is in flight (mirrors App.updateTasks()).
    a.local.tasks = [...a.local.tasks, task("t2")];
    a.mgr.notifyTasksChanged();

    api.gate = null;
    release();
    await p;

    expect(a.local.tasks.map((t) => t.id)).toContain("t2"); // the add must survive
  });

  it("a task DELETED during an in-flight sync is not reverted by the completing cycle", async () => {
    // Repro of "remove a task and it comes back": the user tombstones a task while a sync
    // cycle (snapshot frozen BEFORE the delete) is in flight. The completing cycle must NOT
    // resurrect it from the stale snapshot.
    const api = new FakeBackend();
    const fk = makeFakeScheduler();
    const a = makeDevice(api, "A", { tasks: [task("t1"), task("t2")] }, fk.scheduler);
    await a.mgr.signup("task-del-race@e.com", "pw"); // initial push: [t1, t2]

    let release!: () => void;
    api.gate = new Promise<void>((r) => (release = r));
    const p = a.mgr.syncNow();
    await flush();

    // User deletes t2 (tombstone) while the cycle is in flight (mirrors updateTasks()).
    a.local.tasks = a.local.tasks.map((t) =>
      t.id === "t2" ? { ...t, deleted: true, updated_at: now() } : t,
    );
    a.mgr.notifyTasksChanged();

    api.gate = null;
    release();
    await p;

    expect(a.local.tasks.find((t) => t.id === "t2")?.deleted).toBe(true); // stays deleted
  });
});
