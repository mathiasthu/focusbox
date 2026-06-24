import _sodium from "libsodium-wrappers-sumo";

let sodium: typeof _sodium;

/** Must be awaited once before any other function in this module. Idempotent. */
export async function initCrypto(): Promise<void> {
  await _sodium.ready;
  sodium = _sodium;
}

function ensureReady(): void {
  if (!sodium) {
    throw new Error("crypto not initialized — await initCrypto() before use");
  }
}

// --- locked parameters (also recorded in kdf_params for forward-compat) ---
const KDF_CTX = "fbsync01"; // 8 bytes, crypto_kdf context
const SUBKEY_ENC = 1;
const SUBKEY_AUTH = 2;
const KEY_BYTES = 32;

export interface KdfParams {
  alg: "argon2id";
  v: number;
  ops: number;
  mem: number;
  salt_method: "blake2b-email";
  split: "crypto_kdf";
  ctx: string;
}

function kdfParams(): KdfParams {
  return {
    alg: "argon2id",
    v: sodium.crypto_pwhash_ALG_ARGON2ID13,
    ops: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    mem: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    salt_method: "blake2b-email",
    split: "crypto_kdf",
    ctx: KDF_CTX,
  };
}

function saltFromEmail(email: string): Uint8Array {
  return sodium.crypto_generichash(
    sodium.crypto_pwhash_SALTBYTES,
    sodium.from_string(email.trim().toLowerCase()),
    null,
  );
}

interface DerivedKeys {
  encKey: Uint8Array;
  authKey: Uint8Array;
}

function deriveKeys(email: string, password: string): DerivedKeys {
  const masterKey = sodium.crypto_pwhash(
    KEY_BYTES,
    password,
    saltFromEmail(email),
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const encKey = sodium.crypto_kdf_derive_from_key(KEY_BYTES, SUBKEY_ENC, KDF_CTX, masterKey);
  const authKey = sodium.crypto_kdf_derive_from_key(KEY_BYTES, SUBKEY_AUTH, KDF_CTX, masterKey);
  return { encKey, authKey };
}

// --- AEAD wrap/unwrap (XChaCha20-Poly1305): single base64(nonce ‖ ciphertext) string ---
function aeadWrap(message: Uint8Array, key: Uint8Array): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(message, null, null, nonce, key);
  const combined = new Uint8Array(nonce.length + ct.length);
  combined.set(nonce);
  combined.set(ct, nonce.length);
  return sodium.to_base64(combined);
}

function aeadUnwrap(wrapped: string, key: Uint8Array): Uint8Array {
  const combined = sodium.from_base64(wrapped);
  const n = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = combined.slice(0, n);
  const ct = combined.slice(n);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, nonce, key);
}

function recoveryWrapKey(recoveryKeyBytes: Uint8Array): Uint8Array {
  return sodium.crypto_generichash(KEY_BYTES, recoveryKeyBytes, null);
}

// --- public API ---
export interface SignupPayload {
  auth_hash: string;
  wrapped_adk: string;
  recovery_wrapped_adk: string;
  kdf_params: KdfParams;
}

export interface Session {
  adk: Uint8Array;
  encKey: Uint8Array;
}

export interface CreatedAccount {
  signup: SignupPayload;
  recoveryKey: string;
  session: Session;
}

export async function createAccount(email: string, password: string): Promise<CreatedAccount> {
  ensureReady();
  const { encKey, authKey } = deriveKeys(email, password);
  const adk = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const recoveryBytes = sodium.randombytes_buf(KEY_BYTES);
  const recoveryKey = sodium.to_base64(recoveryBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  return {
    signup: {
      auth_hash: sodium.to_base64(authKey),
      wrapped_adk: aeadWrap(adk, encKey),
      recovery_wrapped_adk: aeadWrap(adk, recoveryWrapKey(recoveryBytes)),
      kdf_params: kdfParams(),
    },
    recoveryKey,
    session: { adk, encKey },
  };
}

export interface Unlocked {
  // snake_case to match the server's JSON contract (auth_hash); same base64(authKey) value.
  auth_hash: string;
  session: Session;
}

/**
 * Phase 1 of login: derive the auth_hash to send to the server and the encKey to
 * finish with, from email+password alone — so Argon2id runs ONCE. The server returns
 * `wrapped_adk` only after authenticating, hence the split (we need auth_hash first).
 */
export interface LoginStart {
  auth_hash: string;
  encKey: Uint8Array;
}

export function startLogin(email: string, password: string): LoginStart {
  ensureReady();
  const { encKey, authKey } = deriveKeys(email, password);
  return { auth_hash: sodium.to_base64(authKey), encKey };
}

/** Phase 2 of login: unwrap the server's wrapped_adk with the encKey from startLogin. */
export function completeLogin(encKey: Uint8Array, wrappedAdk: string): Session {
  ensureReady();
  const adk = aeadUnwrap(wrappedAdk, encKey); // throws if the password is wrong (AEAD auth fails)
  return { adk, encKey };
}

export async function unlockAccount(
  email: string,
  password: string,
  wrappedAdk: string,
): Promise<Unlocked> {
  const { auth_hash, encKey } = startLogin(email, password);
  return { auth_hash, session: completeLogin(encKey, wrappedAdk) };
}

// --- ADK persistence helpers (base64). Local storage of the ADK is acceptable:
// the app already keeps tasks/notes in plaintext on disk, and this never leaves the
// device, so the server-side zero-knowledge property is unaffected. ---
export function adkToBase64(adk: Uint8Array): string {
  ensureReady();
  return sodium.to_base64(adk);
}

export function adkFromBase64(b64: string): Uint8Array {
  ensureReady();
  return sodium.from_base64(b64);
}

export async function recoverWithKey(
  recoveryKey: string,
  recoveryWrappedAdk: string,
): Promise<Uint8Array> {
  ensureReady();
  const recoveryBytes = sodium.from_base64(
    recoveryKey.trim(),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
  return aeadUnwrap(recoveryWrappedAdk, recoveryWrapKey(recoveryBytes)); // returns the ADK
}

/** Re-wrap an existing ADK under a new password (password change / recovery completion). */
export async function rewrapForNewPassword(
  email: string,
  newPassword: string,
  adk: Uint8Array,
): Promise<{ auth_hash: string; wrapped_adk: string; kdf_params: KdfParams }> {
  ensureReady();
  const { encKey, authKey } = deriveKeys(email, newPassword);
  return {
    auth_hash: sodium.to_base64(authKey),
    wrapped_adk: aeadWrap(adk, encKey),
    kdf_params: kdfParams(),
  };
}

export interface EncryptedBlob {
  ciphertext: string;
  nonce: string;
}

export function encryptBlob(plaintext: string, adk: Uint8Array): EncryptedBlob {
  ensureReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(plaintext),
    null,
    null,
    nonce,
    adk,
  );
  return { ciphertext: sodium.to_base64(ct), nonce: sodium.to_base64(nonce) };
}

export function decryptBlob(ciphertext: string, nonce: string, adk: Uint8Array): string {
  ensureReady();
  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    sodium.from_base64(ciphertext),
    null,
    sodium.from_base64(nonce),
    adk,
  );
  return sodium.to_string(pt);
}
