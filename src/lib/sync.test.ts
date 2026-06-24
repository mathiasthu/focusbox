import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto, createAccount } from "./crypto";
import {
  ApiError,
  ConflictError,
  type BlobData,
  type ManifestEntry,
  type PushBody,
  type PushResult,
  type SyncApi,
} from "./api";
import { emptySyncState, syncOnce, type LocalData, type SyncState } from "./sync";
import { type SyncedTask } from "./syncTypes";

// In-memory server mirroring the real optimistic-concurrency semantics (P1a).
class FakeServer implements SyncApi {
  private blobs = new Map<string, { ciphertext: string; nonce: string; version: number }>();
  private clock = 0;

  async getManifest(): Promise<ManifestEntry[]> {
    return [...this.blobs.entries()].map(([key, b]) => ({
      key,
      version: b.version,
      updated_at: String(b.version),
    }));
  }
  async getBlob(_token: string, key: string): Promise<BlobData> {
    const b = this.blobs.get(key);
    if (!b) throw new ApiError(404, "not found");
    return { key, ciphertext: b.ciphertext, nonce: b.nonce, version: b.version, updated_at: String(b.version) };
  }
  async pushBlob(_token: string, body: PushBody): Promise<PushResult> {
    const base = body.base_version ?? 0;
    const cur = this.blobs.get(body.key);
    if (!cur) {
      if (base !== 0) throw new ConflictError(0);
      this.blobs.set(body.key, { ciphertext: body.ciphertext, nonce: body.nonce, version: 1 });
      return { key: body.key, version: 1 };
    }
    if (base !== cur.version) throw new ConflictError(cur.version);
    cur.version += 1;
    cur.ciphertext = body.ciphertext;
    cur.nonce = body.nonce;
    this.clock++;
    return { key: body.key, version: cur.version };
  }
  async deleteBlob(_token: string, key: string): Promise<void> {
    this.blobs.delete(key);
  }
  keys(): string[] {
    return [...this.blobs.keys()];
  }
}

let adk: Uint8Array;

beforeAll(async () => {
  await initCrypto();
  adk = (await createAccount("sync@test.com", "pw")).session.adk;
});

const task = (id: string, over: Partial<SyncedTask> = {}): SyncedTask => ({
  id,
  text: id,
  done: false,
  order: 0,
  updated_at: 1,
  ...over,
});

function device(over: Partial<LocalData> = {}): LocalData {
  return {
    tasks: [],
    notes: { doc: null, updated_at: 0 },
    settings: { theme: "system", accent: "clay", spotifyEnabled: true, updated_at: 0 },
    ...over,
  };
}

const run = (api: SyncApi, local: LocalData, state: SyncState, deviceId: string) =>
  syncOnce({ api, token: "t", adk, local, state, deviceId });

describe("syncOnce orchestration", () => {
  it("propagates a task from device A to device B", async () => {
    const server = new FakeServer();
    await run(server, device({ tasks: [task("t1")] }), emptySyncState(), "A");
    const b = await run(server, device(), emptySyncState(), "B");
    expect(b.local.tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("converges concurrent task edits from two devices", async () => {
    const server = new FakeServer();
    // A creates t1 and syncs
    let a = await run(server, device({ tasks: [task("t1", { updated_at: 1 })] }), emptySyncState(), "A");
    // B syncs (gets t1), then both edit offline
    let b = await run(server, device(), emptySyncState(), "B");
    b.local.tasks = [...b.local.tasks, task("t3", { updated_at: 5 })];
    a.local.tasks = [...a.local.tasks, task("t2", { updated_at: 5 })];
    // B pushes first, then A pushes -> A hits 409, re-pulls, merges, retries
    b = await run(server, b.local, b.state, "B");
    a = await run(server, a.local, a.state, "A");
    // A now has all three; B re-syncs and also has all three
    b = await run(server, b.local, b.state, "B");
    expect(a.local.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
    expect(b.local.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("a delete tombstone propagates across devices", async () => {
    const server = new FakeServer();
    let a = await run(server, device({ tasks: [task("t1", { updated_at: 1 })] }), emptySyncState(), "A");
    let b = await run(server, device(), emptySyncState(), "B");
    expect(b.local.tasks.find((t) => t.id === "t1")?.deleted).toBeFalsy();
    // A deletes t1 (tombstone) and syncs
    a.local.tasks = [task("t1", { deleted: true, updated_at: 9 })];
    a = await run(server, a.local, a.state, "A");
    // B syncs and sees the tombstone
    b = await run(server, b.local, b.state, "B");
    expect(b.local.tasks.find((t) => t.id === "t1")?.deleted).toBe(true);
  });

  it("settings follow last-write-wins", async () => {
    const server = new FakeServer();
    let a = await run(server, device({ settings: { theme: "dark", accent: "forest", spotifyEnabled: false, updated_at: 10 } }), emptySyncState(), "A");
    await run(server, device({ settings: { theme: "light", accent: "plum", spotifyEnabled: true, updated_at: 20 } }), emptySyncState(), "B");
    a = await run(server, a.local, a.state, "A");
    expect(a.local.settings.accent).toBe("plum"); // B's newer write wins
  });

  it("creates a notes conflict-copy when both devices diverge", async () => {
    const server = new FakeServer();
    // A establishes notes baseline
    let a = await run(server, device({ notes: { doc: { v: "base" }, updated_at: 1 } }), emptySyncState(), "A");
    let b = await run(server, device(), emptySyncState(), "B");
    // both edit notes from the same baseline, divergent docs
    a.local.notes = { doc: { v: "A-edit" }, updated_at: 10 };
    b.local.notes = { doc: { v: "B-edit" }, updated_at: 12 };
    a = await run(server, a.local, a.state, "A"); // pushes A-edit (v2)
    b = await run(server, b.local, b.state, "B"); // 409 -> pulls A-edit, both diverged -> conflict copy + B-edit current
    const conflictKeys = server.keys().filter((k) => k.startsWith("notes_conflict:"));
    expect(conflictKeys.length).toBeGreaterThanOrEqual(1);
    // current notes is the newer (B-edit, updated_at 12)
    expect(b.local.notes.doc).toEqual({ v: "B-edit" });
  });

  it("server only ever holds ciphertext (zero-knowledge through the engine)", async () => {
    const server = new FakeServer();
    await run(server, device({ tasks: [task("secret-task")] }), emptySyncState(), "A");
    const blob = await server.getBlob("t", "tasks");
    expect(blob.ciphertext).not.toContain("secret-task");
    expect(JSON.stringify(blob)).not.toContain("secret-task");
  });
});
