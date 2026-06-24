import { beforeAll, describe, expect, it } from "vitest";
import _sodiumLib from "libsodium-wrappers-sumo";
import {
  initCrypto,
  createAccount,
  unlockAccount,
  recoverWithKey,
  rewrapForNewPassword,
  encryptBlob,
  decryptBlob,
} from "./crypto";

function sodium_equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return _sodiumLib.memcmp(a, b);
}

beforeAll(async () => {
  await initCrypto();
});

describe("account key lifecycle", () => {
  it("unlocks with the right password and round-trips a blob", async () => {
    const created = await createAccount("User@Example.com", "correct horse");
    expect(created.signup.auth_hash).toBeTypeOf("string");
    expect(created.signup.wrapped_adk).toBeTypeOf("string");
    expect(created.signup.recovery_wrapped_adk).toBeTypeOf("string");
    expect(created.signup.kdf_params.alg).toBe("argon2id");
    expect(created.recoveryKey).toBeTypeOf("string");

    const unlocked = await unlockAccount(
      "user@example.com", // case-insensitive: same salt
      "correct horse",
      created.signup.wrapped_adk,
    );
    expect(unlocked.authHash).toBe(created.signup.auth_hash);

    const blob = encryptBlob("hello notes", created.session.adk);
    expect(decryptBlob(blob.ciphertext, blob.nonce, unlocked.session.adk)).toBe("hello notes");
  });

  it("rejects a wrong password", async () => {
    const created = await createAccount("a@b.com", "right");
    await expect(
      unlockAccount("a@b.com", "wrong", created.signup.wrapped_adk),
    ).rejects.toThrow();
  });
});

describe("recovery", () => {
  it("recovers the same ADK from the recovery key", async () => {
    const c = await createAccount("r@b.com", "pw");
    const adk = await recoverWithKey(c.recoveryKey, c.signup.recovery_wrapped_adk);
    expect(sodium_equal(adk, c.session.adk)).toBe(true);
  });

  it("rejects a wrong recovery key", async () => {
    const c = await createAccount("r2@b.com", "pw");
    const other = await createAccount("r3@b.com", "pw");
    await expect(
      recoverWithKey(other.recoveryKey, c.signup.recovery_wrapped_adk),
    ).rejects.toThrow();
  });

  it("re-wraps for a new password and unlocks with it", async () => {
    const c = await createAccount("rw@b.com", "old");
    const adk = await recoverWithKey(c.recoveryKey, c.signup.recovery_wrapped_adk);
    const rewrapped = await rewrapForNewPassword("rw@b.com", "new", adk);
    const unlocked = await unlockAccount("rw@b.com", "new", rewrapped.wrapped_adk);
    expect(sodium_equal(unlocked.session.adk, c.session.adk)).toBe(true);
  });
});

describe("integrity & isolation", () => {
  it("rejects a tampered blob", async () => {
    const c = await createAccount("t@b.com", "pw");
    const blob = encryptBlob("secret", c.session.adk);
    const flipped = blob.ciphertext.endsWith("A") ? "B" : "A";
    const bad = blob.ciphertext.slice(0, -1) + flipped;
    expect(() => decryptBlob(bad, blob.nonce, c.session.adk)).toThrow();
  });

  it("produces a unique nonce per encryption", async () => {
    const c = await createAccount("n@b.com", "pw");
    const a = encryptBlob("x", c.session.adk);
    const b = encryptBlob("x", c.session.adk);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("derives different keys for different accounts", async () => {
    const a = await createAccount("u1@b.com", "pw");
    const b = await createAccount("u2@b.com", "pw");
    expect(a.signup.auth_hash).not.toBe(b.signup.auth_hash);
    expect(a.signup.wrapped_adk).not.toBe(b.signup.wrapped_adk);
  });

  it("auth_hash is deterministic but not the wrapped key material", async () => {
    const a1 = await createAccount("d@b.com", "pw");
    const u = await unlockAccount("d@b.com", "pw", a1.signup.wrapped_adk);
    expect(u.authHash).toBe(a1.signup.auth_hash);
    expect(u.authHash).not.toBe(a1.signup.wrapped_adk);
  });
});
