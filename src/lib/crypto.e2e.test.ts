// Cross-stack end-to-end test: client crypto (P1b) <-> sync server (P0 + P1a).
// Skipped by default (needs the focusbox-sync server running). Run with:
//   FOCUSBOX_E2E=1 FOCUSBOX_SYNC_URL=http://localhost:8645 npx vitest run src/lib/crypto.e2e.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import {
  initCrypto,
  createAccount,
  unlockAccount,
  encryptBlob,
  decryptBlob,
} from "./crypto";

const BASE = process.env.FOCUSBOX_SYNC_URL || "http://localhost:8645";
const enabled = !!process.env.FOCUSBOX_E2E;

describe.skipIf(!enabled)("e2e: client crypto <-> sync server", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("signup -> login -> unlock -> encrypt -> push -> pull -> decrypt", async () => {
    const email = `e2e_${Date.now()}@example.com`;
    const password = "correct horse battery staple";

    const created = await createAccount(email, password);

    // signup with the exact crypto-produced payload
    let r = await fetch(`${BASE}/v1/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, ...created.signup }),
    });
    expect(r.status).toBe(201);

    // login: derive auth_hash again (deterministic) and authenticate
    const relogin = await unlockAccount(email, password, created.signup.wrapped_adk);
    r = await fetch(`${BASE}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, auth_hash: relogin.auth_hash }),
    });
    expect(r.status).toBe(200);
    const login = await r.json();
    expect(login.wrapped_adk).toBe(created.signup.wrapped_adk);

    // unlock with the server-returned wrapped_adk, then push an encrypted note
    const unlocked = await unlockAccount(email, password, login.wrapped_adk);
    const token = login.access_token;
    const blob = encryptBlob(JSON.stringify({ doc: "hello e2e" }), unlocked.session.adk);
    r = await fetch(`${BASE}/v1/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key: "notes", ciphertext: blob.ciphertext, nonce: blob.nonce }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).version).toBe(1);

    // pull it back and decrypt
    r = await fetch(`${BASE}/v1/sync/notes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const pulled = await r.json();
    const plain = decryptBlob(pulled.ciphertext, pulled.nonce, unlocked.session.adk);
    expect(JSON.parse(plain).doc).toBe("hello e2e");
  });
});
