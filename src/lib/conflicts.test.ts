import { beforeAll, describe, expect, it } from "vitest";
import { createAccount, decryptBlob, encryptBlob, initCrypto } from "./crypto";
import {
  discardConflict,
  getConflict,
  listConflicts,
  notesPlainText,
  restoreConflict,
} from "./conflicts";
import type { BlobData, ManifestEntry, PushBody, PushResult, SyncApi } from "./api";
import type { NotesValue } from "./syncTypes";

class FakeApi implements SyncApi {
  blobs = new Map<string, { ciphertext: string; nonce: string; version: number }>();
  constructor(private adk: Uint8Array) {}
  put(key: string, value: NotesValue) {
    const { ciphertext, nonce } = encryptBlob(JSON.stringify(value), this.adk);
    this.blobs.set(key, { ciphertext, nonce, version: 1 });
  }
  read(key: string): NotesValue {
    const b = this.blobs.get(key)!;
    return JSON.parse(decryptBlob(b.ciphertext, b.nonce, this.adk)) as NotesValue;
  }
  async getManifest(): Promise<ManifestEntry[]> {
    return [...this.blobs.entries()].map(([key, b]) => ({
      key,
      version: b.version,
      updated_at: "2026-01-01T00:00:00Z",
    }));
  }
  async getBlob(_t: string, key: string): Promise<BlobData> {
    const b = this.blobs.get(key);
    if (!b) throw new Error("404");
    return { key, ciphertext: b.ciphertext, nonce: b.nonce, version: b.version, updated_at: "x" };
  }
  async pushBlob(_t: string, body: PushBody): Promise<PushResult> {
    const cur = this.blobs.get(body.key);
    const version = cur ? cur.version + 1 : 1;
    this.blobs.set(body.key, { ciphertext: body.ciphertext, nonce: body.nonce, version });
    return { key: body.key, version };
  }
  async deleteBlob(_t: string, key: string): Promise<void> {
    this.blobs.delete(key);
  }
  conflictKeys(): string[] {
    return [...this.blobs.keys()].filter((k) => k.startsWith("notes_conflict:"));
  }
}

let adk: Uint8Array;
beforeAll(async () => {
  await initCrypto();
  adk = (await createAccount("c@b.com", "pw")).session.adk;
});

describe("conflicts", () => {
  it("lists only conflict keys, newest first, with device parsed", async () => {
    const api = new FakeApi(adk);
    api.put("notes_conflict:devX-2000", { doc: { x: 1 }, updated_at: 2000 });
    api.put("notes_conflict:devY-3000", { doc: { y: 1 }, updated_at: 3000 });
    api.put("notes", { doc: { real: 1 }, updated_at: 9000 });
    const list = await listConflicts(api, "tok");
    expect(list.map((c) => c.key)).toEqual([
      "notes_conflict:devY-3000",
      "notes_conflict:devX-2000",
    ]);
    expect(list[0].deviceId).toBe("devY");
    expect(list[0].updatedAt).toBe(3000);
  });

  it("decrypts a conflict copy", async () => {
    const api = new FakeApi(adk);
    api.put("notes_conflict:d-1", { doc: { hello: 1 }, updated_at: 1 });
    const c = await getConflict(api, "tok", adk, "notes_conflict:d-1");
    expect(c.doc).toEqual({ hello: 1 });
  });

  it("restore swaps in the copy and backs up the current note", async () => {
    const api = new FakeApi(adk);
    api.put("notes_conflict:d-1000", { doc: { fromCopy: 1 }, updated_at: 1000 });
    const current: NotesValue = { doc: { fromCurrent: 1 }, updated_at: 5000 };
    const res = await restoreConflict({
      api,
      token: "tok",
      adk,
      deviceId: "devR",
      key: "notes_conflict:d-1000",
      current,
      now: 9000,
    });
    expect(res.notes).toEqual({ doc: { fromCopy: 1 }, updated_at: 9000 });
    // the restored copy is gone; a backup of the current note now exists
    expect(api.blobs.has("notes_conflict:d-1000")).toBe(false);
    const backups = api.conflictKeys();
    expect(backups).toHaveLength(1);
    expect(api.read(backups[0]).doc).toEqual({ fromCurrent: 1 });
  });

  it("restore skips the backup when the current note is empty", async () => {
    const api = new FakeApi(adk);
    api.put("notes_conflict:d-1", { doc: { c: 1 }, updated_at: 1 });
    const res = await restoreConflict({
      api,
      token: "tok",
      adk,
      deviceId: "devR",
      key: "notes_conflict:d-1",
      current: { doc: null, updated_at: 0 },
      now: 9000,
    });
    expect(res.notes.doc).toEqual({ c: 1 });
    expect(api.conflictKeys()).toHaveLength(0); // nothing backed up, copy deleted
  });

  it("discard deletes the copy", async () => {
    const api = new FakeApi(adk);
    api.put("notes_conflict:d-1", { doc: { c: 1 }, updated_at: 1 });
    await discardConflict(api, "tok", "notes_conflict:d-1");
    expect(api.blobs.has("notes_conflict:d-1")).toBe(false);
  });

  it("notesPlainText extracts and truncates text", () => {
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
    };
    expect(notesPlainText(doc)).toBe("Hello world");
    expect(notesPlainText(null)).toBe("");
    const long = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(200) }] }],
    };
    expect(notesPlainText(long, 10).length).toBeLessThanOrEqual(11); // 10 + ellipsis
  });
});
