/**
 * The framing defenses added after the v0.2.18 security audit (finding H1).
 *
 * The attack these pin down needs no key material and decrypts nothing. A hostile sync
 * server answers `GET /v1/sync/notes` with the account's own SETTINGS ciphertext. It
 * decrypts cleanly — same ADK, valid Poly1305 tag, and with `aad = null` there is nothing
 * in the sealed message to disagree with the key it arrived under. The parsed value has no
 * `doc` property, so `remote.doc` is `undefined` rather than `null` and the emptiness
 * guards in resolveNotes (which tested `=== null`) both miss. Last-write-wins then picks
 * the settings blob whenever its `updated_at` is the newer of the two — true whenever the
 * user touched a setting more recently than a note — and the doc-less value is written
 * through to React state and to disk.
 *
 * The next cycle completes it: local `doc` is now `undefined`, the guards miss again, the
 * local value wins on timestamp, and the client PUSHES it — with `JSON.stringify` silently
 * dropping the undefined key. A validly-encrypted, doc-less notes blob, authored by the
 * victim's own client under the real ADK, replaces the genuine one and wipes every device
 * through the fully-authenticated path. No conflict copy is produced, because
 * `localChanged` is false after any clean sync.
 *
 * Four independent defenses, each tested here: AEAD framing binding, the blob-key
 * assertion, client-side version monotonicity, and the doc-less guard in the merge.
 */
import { beforeAll, describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import { createAccount, decryptBlob, encryptBlob, initCrypto } from "./crypto";
import { resolveNotes, hasDoc } from "./merge";
import { emptySyncState, syncOnce, SyncIntegrityError, type LocalData } from "./sync";
import { KEY_NOTES, KEY_SETTINGS, type NotesValue, type SettingsValue } from "./syncTypes";
import {
  ApiError,
  ConflictError,
  type BlobData,
  type ManifestEntry,
  type PushBody,
  type PushResult,
  type SyncApi,
} from "./api";

let adk: Uint8Array;
let otherAdk: Uint8Array;

beforeAll(async () => {
  await initCrypto();
  await sodium.ready;
  adk = (await createAccount("framing@test.com", "pw")).session.adk;
  otherAdk = (await createAccount("other@test.com", "pw")).session.adk;
});

const NOW = 1_800_000_000_000;

const settings = (over: Partial<SettingsValue> = {}): SettingsValue => ({
  theme: "system",
  accent: "clay",
  spotifyEnabled: true,
  showTasks: true,
  menubarTimer: true,
  chime: false,
  chimeSound: "bell",
  updated_at: 0,
  ...over,
});

describe("AEAD framing binding (crypto)", () => {
  it("a blob sealed for one key does not decrypt as another", () => {
    const blob = encryptBlob(JSON.stringify(settings({ updated_at: 500 })), adk, KEY_SETTINGS);
    // This is the whole misroute attack: same account, same ADK, valid tag — and it must
    // still fail, because the key it was sealed for is authenticated.
    expect(() => decryptBlob(blob.ciphertext, blob.nonce, adk, KEY_NOTES)).toThrow();
    expect(decryptBlob(blob.ciphertext, blob.nonce, adk, KEY_SETTINGS)).toContain("clay");
  });

  it("a blob sealed by another account does not decrypt, even under the right key", () => {
    const blob = encryptBlob("theirs", otherAdk, KEY_NOTES);
    expect(() => decryptBlob(blob.ciphertext, blob.nonce, adk, KEY_NOTES)).toThrow();
  });

  it("still reads a legacy blob sealed with no associated data", () => {
    // Transition window: blobs written before v0.2.19 have aad = null and must keep
    // opening until every account has re-pushed. Remove with the flag in crypto.ts.
    const legacy = legacyEncrypt("older client wrote this", adk);
    expect(decryptBlob(legacy.ciphertext, legacy.nonce, adk, KEY_NOTES)).toBe(
      "older client wrote this",
    );
  });
});

/** Reproduces the pre-v0.2.19 wire format: XChaCha20-Poly1305 with `aad = null`. */
function legacyEncrypt(plaintext: string, key: Uint8Array): { ciphertext: string; nonce: string } {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(plaintext),
    null,
    null,
    nonce,
    key,
  );
  return { ciphertext: sodium.to_base64(ct), nonce: sodium.to_base64(nonce) };
}

describe("doc-less notes values (merge)", () => {
  const note = (doc: unknown, updated_at: number): NotesValue =>
    ({ doc, updated_at }) as NotesValue;
  /** What a misrouted settings blob parses into: every field EXCEPT `doc`. */
  const docLess = (updated_at: number): NotesValue =>
    settings({ updated_at }) as unknown as NotesValue;

  it("hasDoc treats a missing doc key exactly like an explicit null", () => {
    expect(hasDoc(note(null, 1))).toBe(false);
    expect(hasDoc(docLess(1))).toBe(false);
    expect(hasDoc(note({ real: 1 }, 1))).toBe(true);
  });

  it("a doc-less remote never overwrites a real local note, however new it is", () => {
    const res = resolveNotes(note({ real: 1 }, 100), docLess(999_999), 50);
    expect(res.current.doc).toEqual({ real: 1 });
    expect(res.conflict).toBeUndefined();
  });

  it("a doc-less local never overwrites a real remote note, however new it is", () => {
    const res = resolveNotes(docLess(999_999), note({ real: 1 }, 100), 50);
    expect(res.current.doc).toEqual({ real: 1 });
  });

  it("two doc-less sides settle on an explicit null, never an absent key", () => {
    const res = resolveNotes(docLess(10), docLess(20), 5);
    expect(res.current.doc).toBeNull();
    // The killer detail: JSON.stringify drops an undefined value, so a result carrying
    // `doc: undefined` would be pushed as a blob with no doc key at all.
    expect(JSON.parse(JSON.stringify(res.current))).toHaveProperty("doc");
  });
});

// --- a server that misbehaves in exactly the ways the audit described ---

type StoredBlob = { ciphertext: string; nonce: string; version: number };

class HostileServer implements SyncApi {
  blobs = new Map<string, StoredBlob>();
  /** answer a GET for `from` with the blob stored under `to` */
  misroute: { from: string; to: string } | null = null;
  /** report this version in the manifest for `key`, whatever is really stored */
  manifestOverride: { key: string; version: number } | null = null;

  seed(key: string, value: unknown, version = 1, sealedAs = key): void {
    const { ciphertext, nonce } = encryptBlob(JSON.stringify(value), adk, sealedAs);
    this.blobs.set(key, { ciphertext, nonce, version });
  }
  async getManifest(): Promise<ManifestEntry[]> {
    const out = [...this.blobs.entries()].map(([key, b]) => ({
      key,
      version: b.version,
      updated_at: String(b.version),
    }));
    if (this.manifestOverride) {
      const hit = out.find((e) => e.key === this.manifestOverride!.key);
      if (hit) hit.version = this.manifestOverride.version;
      else out.push({
        key: this.manifestOverride.key,
        version: this.manifestOverride.version,
        updated_at: "0",
      });
    }
    return out;
  }
  async getBlob(_t: string, key: string): Promise<BlobData> {
    const source = this.misroute?.from === key ? this.misroute.to : key;
    const b = this.blobs.get(source);
    if (!b) throw new ApiError(404, "not found");
    // Note the label: the server claims this IS the requested key. A server willing to
    // misroute is equally willing to lie about it.
    return { key, ciphertext: b.ciphertext, nonce: b.nonce, version: b.version, updated_at: "x" };
  }
  async pushBlob(_t: string, body: PushBody): Promise<PushResult> {
    const cur = this.blobs.get(body.key);
    const base = body.base_version ?? 0;
    if ((cur?.version ?? 0) !== base) throw new ConflictError(cur?.version ?? 0);
    const version = (cur?.version ?? 0) + 1;
    this.blobs.set(body.key, { ciphertext: body.ciphertext, nonce: body.nonce, version });
    return { key: body.key, version };
  }
  async deleteBlob(_t: string, key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

const local = (over: Partial<LocalData> = {}): LocalData => ({
  tasks: [],
  notes: { doc: { real: "user notes" }, updated_at: 100 },
  settings: settings({ updated_at: 500 }),
  ...over,
});

describe("hostile server (sync)", () => {
  it("refuses a settings blob served as the notes blob", async () => {
    const server = new HostileServer();
    server.seed(KEY_SETTINGS, settings({ updated_at: 500 }));
    server.seed(KEY_NOTES, { doc: { real: "user notes" }, updated_at: 100 });
    server.misroute = { from: KEY_NOTES, to: KEY_SETTINGS };

    await expect(
      syncOnce({ api: server, token: "t", adk, local: local(), state: emptySyncState(), now: NOW }),
    ).rejects.toThrow();
  });

  it("refuses a manifest that rolls a blob's version backwards", async () => {
    const server = new HostileServer();
    server.seed(KEY_NOTES, { doc: { real: "user notes" }, updated_at: 100 }, 7);
    const state = { ...emptySyncState(), versions: { [KEY_NOTES]: 7 } };
    server.manifestOverride = { key: KEY_NOTES, version: 3 };

    await expect(
      syncOnce({ api: server, token: "t", adk, local: local(), state, now: NOW }),
    ).rejects.toThrow(SyncIntegrityError);
  });

  it("refuses a manifest that drops a blob this client has already synced", async () => {
    const server = new HostileServer();
    const state = { ...emptySyncState(), versions: { [KEY_NOTES]: 4 } };
    await expect(
      syncOnce({ api: server, token: "t", adk, local: local(), state, now: NOW }),
    ).rejects.toThrow(SyncIntegrityError);
  });

  it("aborts before writing anything when the rollback is on a later blob", async () => {
    // The versioned keys are all checked up front, so a rollback on `notes` can't be
    // reached only after `tasks` has already been merged and pushed.
    const server = new HostileServer();
    const state = { ...emptySyncState(), versions: { [KEY_NOTES]: 9 } };
    await expect(
      syncOnce({ api: server, token: "t", adk, local: local(), state, now: NOW }),
    ).rejects.toThrow(SyncIntegrityError);
    expect(server.blobs.size).toBe(0);
  });

  it("accepts an honest server unchanged", async () => {
    const server = new HostileServer();
    const res = await syncOnce({
      api: server,
      token: "t",
      adk,
      local: local(),
      state: emptySyncState(),
      now: NOW,
    });
    expect(res.local.notes.doc).toEqual({ real: "user notes" });
    expect(res.state.versions[KEY_NOTES]).toBe(1);
  });
});

describe("future-timestamp clamp (sync)", () => {
  it("pulls a far-future remote task stamp back to the skew window", async () => {
    // Unclamped, `updated_at: 2099` beats every honest edit AND every tombstone, so a
    // deleted task resurrects on every sync, on every device, until the wall clock passes
    // the poisoned value.
    const server = new HostileServer();
    const poisoned = Date.UTC(2099, 0, 1);
    server.seed(
      "tasks",
      { items: [{ id: "t1", text: "wedged", done: false, order: 0, updated_at: poisoned }] },
      1,
    );
    const res = await syncOnce({
      api: server,
      token: "t",
      adk,
      local: local({ tasks: [] }),
      state: emptySyncState(),
      now: NOW,
    });
    const t1 = res.local.tasks.find((t) => t.id === "t1")!;
    expect(t1.updated_at).toBeLessThanOrEqual(NOW + 24 * 60 * 60 * 1000);
  });

  it("a tombstone still wins against a clamped future stamp", async () => {
    const server = new HostileServer();
    const poisoned = Date.UTC(2099, 0, 1);
    server.seed(
      "tasks",
      { items: [{ id: "t1", text: "wedged", done: false, order: 0, updated_at: poisoned }] },
      1,
    );
    const res = await syncOnce({
      api: server,
      token: "t",
      adk,
      local: local({
        tasks: [{ id: "t1", text: "wedged", done: false, order: 0, updated_at: NOW, deleted: true }],
      }),
      state: emptySyncState(),
      now: NOW,
    });
    expect(res.local.tasks.find((t) => t.id === "t1")?.deleted).toBe(true);
  });
});
