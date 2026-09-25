import { verify } from "node:crypto";
import trust from "./update-trust.json";

/** The signed bytes bind an installer to its exact name, version and digest.
 * The release signer uses the same v1 JSON field order (covered end to end). */
export function verifyUpdateSignature(
  manifest: unknown,
  expected: { version: string; name: string; sha256: string },
  publicKey = trust.publicKey,
): void {
  const proof = manifest as Record<string, unknown> | null;
  if (!proof || proof.format !== 1 || proof.version !== expected.version || proof.name !== expected.name ||
      proof.sha256 !== expected.sha256 || typeof proof.signature !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature) ||
      !verify(null, Buffer.from(JSON.stringify({ format: 1, version: expected.version, name: expected.name, sha256: expected.sha256 })), publicKey, Buffer.from(proof.signature, "base64"))) {
    throw new Error("Update signature is missing or invalid. Refusing to install this update.");
  }
}
