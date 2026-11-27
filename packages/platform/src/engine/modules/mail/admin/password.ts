import { createHash, randomBytes } from "node:crypto";

/** Dovecot SSHA512 stores SHA512(password || salt) followed by the same salt. */
export function hashPassword(plaintext: string): string {
  const salt = randomBytes(16);
  const digest = createHash("sha512").update(plaintext, "utf8").update(salt).digest();
  return "{SSHA512}" + Buffer.concat([digest, salt]).toString("base64");
}
