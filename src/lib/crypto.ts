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
// Keyed-BLAKE2b domain separation: the recovery auth hash must be independent of the
// recovery WRAP key (which is the null-keyed generichash of the same bytes).
const RECOVERY_AUTH_PERSONAL = "fbsync01-recovery-auth";
// Domain-separated tag identifying WHICH account owns the local app data. Derived from
// the ADK — a 32-byte random key — so the on-disk marker can't be brute-forced back to
// an identity the way a hash of the (low-entropy, guessable) email could.
const OWNER_TAG_PERSONAL = "fbsync01-owner-tag";
const OWNER_TAG_BYTES = 16;

// --- AEAD associated data (framing binding) ---
// XChaCha20-Poly1305 authenticates the ciphertext but says NOTHING about where that
// ciphertext was supposed to live. Without associated data every blob on an account is
// interchangeable: a hostile server can answer a request for `notes` with the account's
// own `settings` ciphertext and it decrypts cleanly under the same ADK, because nothing
// in the sealed message disagrees. Binding the blob key and the owner tag into the AAD
// makes a misrouted or cross-account ciphertext fail authentication instead.
const AAD_BLOB = "fbsync01-blob";

// The two ADK wrappers deliberately DO NOT get associated data.
//
// Domain-separating them would buy almost nothing — `wrapped_adk` and
// `recovery_wrapped_adk` are already sealed under different keys (encKey vs the recovery
// wrap key), so neither can be unwrapped in the other's slot regardless. What it would
// cost is the two worst lockouts available: once a new client re-wrapped, an older client
// would fail `completeLogin` and tell the user their CORRECT password is wrong, and fail
// `recoverWithKey` and tell a user holding a VALID recovery key — on the last-resort path
// — that it doesn't work. Blob framing is where the binding actually stops an attack, so
// that is where it is spent.

/**
 * Accept ciphertexts sealed by pre-v0.2.19 clients, which used `aad = null`.
 *
 * Every blob is re-sealed with AAD the first time an upgraded client pushes that key, so
 * this only has to cover the window where older blobs (and older devices) are still in
 * play. It is a downgrade path by construction — while it is on, a hostile server can
 * still present a legacy ciphertext for the wrong key — which is why the framing checks
 * in sync.ts (blob-key assertion, version monotonicity) and the null-doc guard in
 * merge.ts are independent defenses rather than belt-and-braces for this one.
 *
 * REMOVE in a release after every account has re-pushed under the new format.
 */
const ACCEPT_LEGACY_UNAUTHENTICATED_FRAMING = true;

function aadBytes(parts: string[]): Uint8Array {
  // NUL-joined so no combination of components can be re-split into a different tuple.
  return sodium.from_string(parts.join("\0"));
}

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

function recoveryAuthBytes(recoveryKeyBytes: Uint8Array): Uint8Array {
  return sodium.crypto_generichash(
    KEY_BYTES,
    recoveryKeyBytes,
    sodium.from_string(RECOVERY_AUTH_PERSONAL),
  );
}

/** A stable, one-way tag for the account that owns the local app data. Same ADK → same
 * tag on every launch; reveals neither the email nor the key. */
export function ownerTagFromAdk(adk: Uint8Array): string {
  ensureReady();
  const tag = sodium.crypto_generichash(
    OWNER_TAG_BYTES,
    adk,
    sodium.from_string(OWNER_TAG_PERSONAL),
  );
  return sodium.to_base64(tag, sodium.base64_variants.URLSAFE_NO_PADDING);
}

// --- public API ---
export interface SignupPayload {
  auth_hash: string;
  wrapped_adk: string;
  recovery_wrapped_adk: string;
  recovery_auth_hash: string;
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
      recovery_auth_hash: sodium.to_base64(recoveryAuthBytes(recoveryBytes)),
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
  // throws if the password is wrong (AEAD auth fails)
  const adk = aeadUnwrap(wrappedAdk, encKey);
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

/** Recompute the recovery auth hash from the user-entered recovery key (for the
 * recover flow). Throws if the key isn't valid base64url. */
export function recoveryAuthHashFromKey(recoveryKey: string): string {
  ensureReady();
  const recoveryBytes = sodium.from_base64(
    recoveryKey.trim(),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
  return sodium.to_base64(recoveryAuthBytes(recoveryBytes));
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
  // returns the ADK
  return aeadUnwrap(recoveryWrappedAdk, recoveryWrapKey(recoveryBytes));
}

export interface RegeneratedRecovery {
  /** shown to the user once; never persisted */
  recoveryKey: string;
  recovery_wrapped_adk: string;
  recovery_auth_hash: string;
}

/**
 * Mint fresh recovery material for an ADK the caller already holds.
 *
 * The ADK itself is unchanged — only its recovery-side wrapper rolls — so no blob has to
 * be re-encrypted and every device keeps working. This is what makes a leaked recovery
 * key revocable: the old key's wrap key no longer opens `recovery_wrapped_adk`, and its
 * `recovery_auth_hash` no longer matches the stored one, so it can neither read the ADK
 * nor authorize a password reset.
 *
 * It does NOT undo a leak that already happened: an attacker who copied the ADK before
 * rotation keeps it. Re-keying the ADK (and re-encrypting every blob) is the only answer
 * to that, and is deliberately not implemented.
 */
export function regenerateRecoveryKey(adk: Uint8Array): RegeneratedRecovery {
  ensureReady();
  const recoveryBytes = sodium.randombytes_buf(KEY_BYTES);
  return {
    recoveryKey: sodium.to_base64(recoveryBytes, sodium.base64_variants.URLSAFE_NO_PADDING),
    recovery_wrapped_adk: aeadWrap(adk, recoveryWrapKey(recoveryBytes)),
    recovery_auth_hash: sodium.to_base64(recoveryAuthBytes(recoveryBytes)),
  };
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

/** Ties a sealed blob to the key it is stored under AND the account that owns it. */
function blobAad(key: string, adk: Uint8Array): Uint8Array {
  return aadBytes([AAD_BLOB, key, ownerTagFromAdk(adk)]);
}

/** `key` is the server blob key this ciphertext will be stored under. It is authenticated,
 * not encrypted — a blob sealed for one key can never be decrypted as another. */
export function encryptBlob(plaintext: string, adk: Uint8Array, key: string): EncryptedBlob {
  ensureReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(plaintext),
    blobAad(key, adk),
    null,
    nonce,
    adk,
  );
  return { ciphertext: sodium.to_base64(ct), nonce: sodium.to_base64(nonce) };
}

/** `key` must be the key the caller ASKED the server for, not the one the server claims
 * to have answered with — otherwise the binding checks nothing. */
export function decryptBlob(
  ciphertext: string,
  nonce: string,
  adk: Uint8Array,
  key: string,
): string {
  ensureReady();
  const ct = sodium.from_base64(ciphertext);
  const n = sodium.from_base64(nonce);
  let pt: Uint8Array;
  try {
    pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, blobAad(key, adk), n, adk);
  } catch (e) {
    if (!ACCEPT_LEGACY_UNAUTHENTICATED_FRAMING) throw e;
    // Pre-v0.2.19 blob (aad = null). Re-sealed with AAD on the next push of this key.
    pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, n, adk);
  }
  return sodium.to_string(pt);
}
