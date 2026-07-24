import { afterEach, beforeAll, describe, expect, it } from "bun:test";

const INITIAL_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Set both values before src/env is loaded. Otherwise its development fallback
// writes generated secrets to .dev-secrets.json during the test run.
process.env.SESSION_ENCRYPTION_KEY = INITIAL_KEY;
process.env.BRANDING_ADMIN_TOKEN = "test-branding-token";

let encryptSecret: typeof import("../src/lib/crypto").encryptSecret;
let decryptSecret: typeof import("../src/lib/crypto").decryptSecret;
let env: typeof import("../src/env").env;

beforeAll(async () => {
  ({ encryptSecret, decryptSecret } = await import("../src/lib/crypto"));
  ({ env } = await import("../src/env"));
});

// getKey reads the imported env object on every call. Restore it so one key
// validation case cannot change the credentials used by a later case.
afterEach(() => {
  env.SESSION_ENCRYPTION_KEY = INITIAL_KEY;
});

describe("encryptSecret / decryptSecret", () => {
  it("accepts the exact empty-payload boundary and rejects one byte less", () => {
    // 28 bytes is a valid empty ciphertext: 12 bytes of IV plus 16 bytes of
    // tag. A 27-byte buffer must not reach GCM with a truncated framing.
    const payload = encryptSecret("");

    expect(payload.length).toBe(28);
    expect(decryptSecret(payload)).toBe("");
    expect(() => decryptSecret(Buffer.alloc(27))).toThrow("Encrypted payload too short");
  });

  it("uses a fresh IV for each encryption of the same plaintext", () => {
    // Reusing an IV would let a reader of the session table link equal IMAP
    // passwords across accounts and would break GCM authentication safety.
    const first = encryptSecret("same secret");
    const second = encryptSecret("same secret");

    expect(first.equals(second)).toBe(false);
    expect(first.subarray(0, 12).equals(second.subarray(0, 12))).toBe(false);
    expect(decryptSecret(first)).toBe("same secret");
    expect(decryptSecret(second)).toBe("same secret");
  });

  it("rejects a bit flip in the ciphertext body", () => {
    const payload = encryptSecret("tamper detection");
    const tampered = Buffer.from(payload);
    tampered[12] = tampered[12]! ^ 1;

    // Without authenticated ciphertext, a modified stored password could be
    // sent to IMAP and look like a real credential failure to the user.
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects a bit flip in the authentication tag", () => {
    const payload = encryptSecret("tamper detection");
    const tampered = Buffer.from(payload);
    tampered[payload.length - 1] = tampered[payload.length - 1]! ^ 1;

    // The tag is the check that makes a database read-only to an attacker who
    // cannot produce a valid replacement password.
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects a bit flip in the IV", () => {
    const payload = encryptSecret("tamper detection");
    const tampered = Buffer.from(payload);
    tampered[0] = tampered[0]! ^ 1;

    // IV tampering must fail too; accepting it would make the stored framing
    // part of the unauthenticated attack surface.
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects keys with invalid length, alphabet, or empty values", () => {
    for (const invalid of ["a".repeat(63), "a".repeat(65), "g".repeat(64), ""]) {
      env.SESSION_ENCRYPTION_KEY = invalid;
      expect(() => encryptSecret("secret")).toThrow("SESSION_ENCRYPTION_KEY");
    }
  });

  it("accepts uppercase hexadecimal keys", () => {
    // Operators often paste a key in uppercase. Rejecting A-F here would make
    // valid session keys fail only after deployment.
    env.SESSION_ENCRYPTION_KEY = INITIAL_KEY.toUpperCase();
    const payload = encryptSecret("uppercase key");

    expect(decryptSecret(payload)).toBe("uppercase key");
  });

  it("fails loudly when decrypting with another valid key", () => {
    const payload = encryptSecret("wrong key");
    env.SESSION_ENCRYPTION_KEY = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    // A rotated key must invalidate old sessions, not return garbage that is
    // later passed to an IMAP server as if it were a user password.
    expect(() => decryptSecret(payload)).toThrow();
  });

  it("round trips empty, several kilobytes, and UTF-8 plaintext byte-exactly", () => {
    // IMAP passwords can contain emoji, CJK, and combining marks. Treating
    // JavaScript characters as bytes would lock those users out on every login.
    for (const plaintext of ["", "x".repeat(8192), "emoji 🔐, CJK 日本語, combining é"]) {
      expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
    }
  });
});
