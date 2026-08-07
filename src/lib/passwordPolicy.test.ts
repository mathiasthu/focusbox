import { describe, expect, it } from "vitest";
import { checkPassword, MIN_PASSWORD_LENGTH } from "./passwordPolicy";

describe("password policy", () => {
  it("rejects anything under the minimum length", () => {
    // Signup used to be gated on `!password` alone, so "a" was a valid account password.
    expect(checkPassword("a").acceptable).toBe(false);
    expect(checkPassword("x".repeat(MIN_PASSWORD_LENGTH - 1)).acceptable).toBe(false);
  });

  it("says nothing at all for an empty field", () => {
    const v = checkPassword("");
    expect(v.acceptable).toBe(false);
    expect(v.message).toBeNull();
  });

  it("accepts a long passphrase", () => {
    const v = checkPassword("correct horse battery staple");
    expect(v.acceptable).toBe(true);
    expect(v.strength).toBe("strong");
  });

  it("rejects a long-but-common password", () => {
    // Length alone is not the property that matters: `password123456` clears 12 characters
    // and falls to the first list an offline cracker tries.
    expect(checkPassword("password123456").acceptable).toBe(false);
    expect(checkPassword("iloveyouiloveyou").acceptable).toBe(false);
  });

  it("rejects a long-but-repetitive password", () => {
    expect(checkPassword("aaaaaaaaaaaaaaaa").acceptable).toBe(false);
    expect(checkPassword("abcabcabcabcabc").acceptable).toBe(false);
  });

  it("rejects a password built from the email address", () => {
    expect(checkPassword("mathias-streander-1", "mathias@example.com").acceptable).toBe(false);
    // ...and doesn't over-trigger on a short local part
    expect(checkPassword("a-fine-long-passphrase", "me@example.com").acceptable).toBe(true);
  });

  it("grades strength without blocking anything acceptable", () => {
    const fair = checkPassword("greenhousely"); // 12 chars, one character class
    expect(fair.acceptable).toBe(true);
    expect(fair.strength).toBe("fair");
    expect(fair.message).not.toBeNull(); // encouragement, not a gate
    expect(checkPassword("Zqx7vt-plum2").strength).toBe("good");
    expect(checkPassword("Zqx7vt-plum2-nectarine!").strength).toBe("strong");
  });
});
