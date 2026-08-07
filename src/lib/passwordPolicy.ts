/**
 * Password rules for signup and password reset.
 *
 * There was no policy of any kind: signup was gated on `!password`, so a one-character
 * password was accepted at signup, at reset, and at every login. That matters here more
 * than in an ordinary web app, because the password is not just a login credential — it
 * derives the key that wraps the account data key. If the server's user table leaks, the
 * attacker gets `wrapped_adk`, which is an offline verifier: derive `encKey` from a
 * guess, attempt the 48-byte decrypt, and the Poly1305 tag confirms the hit. No server is
 * involved and no rate limit applies.
 *
 * Argon2id at interactive parameters (ops=2, mem=64 MiB, p=1) is what stands between a
 * guess and an answer, and it is doing its job: roughly 1–3 kH/s on a high-end GPU, so a
 * decent passphrase never falls. A rockyou-class list against a weak password falls in
 * about twenty minutes. The KDF is not the weak link; the absent policy was.
 *
 * The check has to live in the client: only `auth_hash` ever crosses the wire, so the
 * server structurally cannot see a password to judge. That also means this is advice a
 * modified client can ignore — which is fine, since the only account it protects is the
 * one whose password is being set.
 *
 * The LOGIN path is deliberately left ungated: existing accounts with short passwords
 * must still be able to sign in (and then change it).
 */

export const MIN_PASSWORD_LENGTH = 12;

export type PasswordStrength = "weak" | "fair" | "good" | "strong";

export interface PasswordVerdict {
  /** may this password be used to create/reset an account? */
  acceptable: boolean;
  strength: PasswordStrength;
  /** short human-readable reason or hint; null when there is nothing to say */
  message: string | null;
}

/** Passwords and stems that show up at the top of every breach corpus. Not a real
 * blocklist — a real one is megabytes — just enough to catch the reflexive choices. */
const COMMON = [
  "password",
  "passw0rd",
  "letmein",
  "welcome",
  "qwerty",
  "azerty",
  "iloveyou",
  "admin",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "trustno1",
  "changeme",
  "secret",
  "abc123",
  "123456",
  "111111",
  "000000",
  "focusbox",
];

function classesUsed(pw: string): number {
  let n = 0;
  if (/[a-z]/.test(pw)) n++;
  if (/[A-Z]/.test(pw)) n++;
  if (/[0-9]/.test(pw)) n++;
  if (/[^a-zA-Z0-9]/.test(pw)) n++;
  return n;
}

/** A single character or short pattern repeated to length ("aaaaaaaaaaaa", "abcabcabc"). */
function isLowVariety(pw: string): boolean {
  if (new Set(pw).size <= 3) return true;
  for (let unit = 1; unit <= 4; unit++) {
    if (pw.length % unit !== 0 || pw.length / unit < 3) continue;
    const head = pw.slice(0, unit);
    if (pw === head.repeat(pw.length / unit)) return true;
  }
  return false;
}

function containsCommon(pw: string): boolean {
  const lower = pw.toLowerCase();
  return COMMON.some((c) => lower.includes(c));
}

/** The local part of the email, if it is long enough to be a meaningful match. */
function emailStem(email: string | undefined): string | null {
  const local = (email ?? "").trim().toLowerCase().split("@")[0] ?? "";
  return local.length >= 4 ? local : null;
}

export function checkPassword(password: string, email?: string): PasswordVerdict {
  if (password.length === 0) {
    return { acceptable: false, strength: "weak", message: null };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      acceptable: false,
      strength: "weak",
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters — this one unlocks your encrypted data, and we can't reset it for you.`,
    };
  }
  const stem = emailStem(email);
  if (stem !== null && password.toLowerCase().includes(stem)) {
    return {
      acceptable: false,
      strength: "weak",
      message: "Don't build the password out of your email address — it's the first thing tried.",
    };
  }
  if (containsCommon(password)) {
    return {
      acceptable: false,
      strength: "weak",
      message: "That contains a very common password. Try a phrase of a few unrelated words.",
    };
  }
  if (isLowVariety(password)) {
    return {
      acceptable: false,
      strength: "weak",
      message: "That's a short pattern repeated. Try a phrase of a few unrelated words.",
    };
  }

  // Acceptable from here on; the rest is encouragement, not a gate.
  const classes = classesUsed(password);
  const strength: PasswordStrength =
    password.length >= 20 || (password.length >= 16 && classes >= 3)
      ? "strong"
      : password.length >= 16 || classes >= 3
        ? "good"
        : "fair";
  return {
    acceptable: true,
    strength,
    message:
      strength === "fair"
        ? "Fine, but a longer passphrase of several words would be much stronger."
        : null,
  };
}
