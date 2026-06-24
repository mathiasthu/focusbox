// Full-stack end-to-end test: real createHttpApi (the actual HTTP paths) + SyncManager
// + real crypto <-> the running focusbox-sync server. This is the piece the unit tests
// can't cover (they use an in-memory FakeServer). Skipped by default. Run with:
//   FOCUSBOX_E2E=1 FOCUSBOX_SYNC_URL=http://localhost:8645 npx vitest run src/lib/syncStack.e2e.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto } from "./crypto";
import { createHttpApi } from "./api";
import { SyncManager, type LocalSnapshot, type MergedSnapshot } from "./syncManager";
import type { SyncPersist } from "./syncStore";
import type { SyncedTask } from "./syncTypes";

const BASE = process.env.FOCUSBOX_SYNC_URL || "http://localhost:8645";
const enabled = !!process.env.FOCUSBOX_E2E;

let counter = 1000;
const now = () => ++counter;

function makeDevice(name: string, local?: Partial<LocalSnapshot>) {
  const state: LocalSnapshot = {
    tasks: [],
    notesDoc: null,
    settings: { theme: "system", accent: "clay", spotifyEnabled: true },
    ...local,
  };
  const persist = { value: null as SyncPersist | null };
  const mgr = new SyncManager({
    api: createHttpApi(BASE), // real HTTP client, global fetch
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
      newDeviceId: () => `e2e-${name}`,
    },
    getLocal: () => state,
    onMerged: (m: MergedSnapshot) => {
      state.tasks = m.tasks;
      state.notesDoc = m.notesDoc;
      state.settings = m.settings;
    },
    onChange: () => {},
  });
  return { mgr, state, persist };
}

const task = (id: string, over: Partial<SyncedTask> = {}): SyncedTask => ({
  id,
  text: id,
  done: false,
  order: 0,
  updated_at: now(),
  ...over,
});

describe.skipIf(!enabled)("e2e: createHttpApi + SyncManager <-> server", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("two devices converge over the real HTTP stack", async () => {
    const email = `stack_${Date.now()}@example.com`;
    const password = "correct horse battery staple";

    // Device A: signup with a task + notes, pushes to the server.
    const a = makeDevice("A", { tasks: [task("t1", { text: "from A" })], notesDoc: { v: "A-note" } });
    await a.mgr.signup(email, password);
    expect(a.mgr.snapshot().status).toBe("idle");
    expect(a.mgr.snapshot().recoveryKey).toBeTypeOf("string");

    // Device B: fresh login adopts A's data (no junk conflict copy).
    const b = makeDevice("B");
    await b.mgr.login(email, password);
    expect(b.mgr.snapshot().status).toBe("idle");
    expect(b.state.tasks.map((t) => t.id)).toContain("t1");
    expect(b.state.notesDoc).toEqual({ v: "A-note" });

    // Device B adds a task; A pulls it back -> convergence.
    b.state.tasks = [...b.state.tasks, task("t2", { text: "from B" })];
    b.mgr.notifyTasksChanged();
    await b.mgr.syncNow();
    await a.mgr.syncNow();
    expect(a.state.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);

    // Server holds ciphertext only: the raw blob must not contain the plaintext.
    const token = b.persist.value!.accessToken;
    const r = await fetch(`${BASE}/v1/sync/tasks`, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const raw = JSON.stringify(await r.json());
    expect(raw).not.toContain("from A");
    expect(raw).not.toContain("from B");
  });
});
