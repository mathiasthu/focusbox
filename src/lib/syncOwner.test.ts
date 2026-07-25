import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto, ownerTagFromAdk } from "./crypto";
import {
  emptyOwnerRecord,
  normalizeOwnerRecord,
  trimStash,
  MAX_STASHED_OWNERS,
  UNKNOWN_OWNER_TAG,
  type OwnerStash,
} from "./syncOwner";

const adk = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const stashed = (savedAt: number): OwnerStash => ({ tasks: [], notesDoc: null, savedAt });

beforeAll(async () => {
  await initCrypto();
});

describe("ownerTagFromAdk", () => {
  it("is stable for the same account key", () => {
    expect(ownerTagFromAdk(adk(7))).toBe(ownerTagFromAdk(adk(7)));
  });

  it("differs between two accounts", () => {
    expect(ownerTagFromAdk(adk(7))).not.toBe(ownerTagFromAdk(adk(8)));
  });

  it("does not carry the account key itself (one-way, truncated digest)", () => {
    const key = adk(7);
    const tag = ownerTagFromAdk(key);
    const keyB64 = Buffer.from(key).toString("base64").replace(/=+$/, "");
    expect(tag).not.toContain(keyB64);
    expect(tag.length).toBeLessThan(keyB64.length); // 16-byte tag < 32-byte key
  });
});

describe("trimStash", () => {
  it("keeps the newest owners and drops the oldest beyond the cap", () => {
    const stash: Record<string, OwnerStash> = {};
    for (let i = 0; i <= MAX_STASHED_OWNERS; i++) stash[`tag-${i}`] = stashed(i);

    const kept = trimStash(stash, MAX_STASHED_OWNERS);

    expect(Object.keys(kept)).toHaveLength(MAX_STASHED_OWNERS);
    expect(kept["tag-0"]).toBeUndefined(); // oldest dropped
    expect(kept[`tag-${MAX_STASHED_OWNERS}`]).toBeDefined(); // newest kept
  });

  it("leaves a stash under the cap untouched", () => {
    const stash = { a: stashed(1), b: stashed(2) };
    expect(trimStash(stash, MAX_STASHED_OWNERS)).toEqual(stash);
  });
});

describe("emptyOwnerRecord", () => {
  it("starts with no owner and no stash", () => {
    expect(emptyOwnerRecord()).toEqual({ tag: null, stash: {} });
  });
});

describe("normalizeOwnerRecord", () => {
  it("reports an absent record as absent (nothing has claimed the data yet)", () => {
    expect(normalizeOwnerRecord(null)).toBeNull();
    expect(normalizeOwnerRecord(undefined)).toBeNull();
  });

  it("passes a well-formed record through, including a legitimate null tag", () => {
    const rec = { tag: null, stash: {} };
    expect(normalizeOwnerRecord(rec)).toEqual(rec);
    const owned = { tag: "abc", stash: { abc: stashed(1) } };
    expect(normalizeOwnerRecord(owned)).toEqual(owned);
  });

  it("turns a malformed record into an unknown owner, never into an unowned one", () => {
    expect(normalizeOwnerRecord({ garbage: true })?.tag).toBe(UNKNOWN_OWNER_TAG);
    expect(normalizeOwnerRecord("nonsense")?.tag).toBe(UNKNOWN_OWNER_TAG);
    expect(normalizeOwnerRecord({ tag: 42 })?.tag).toBe(UNKNOWN_OWNER_TAG);
  });

  it("keeps a usable stash even when the tag is unreadable", () => {
    const rec = normalizeOwnerRecord({ tag: 42, stash: { keepme: stashed(9) } });
    expect(rec?.stash.keepme).toEqual(stashed(9));
  });
});
