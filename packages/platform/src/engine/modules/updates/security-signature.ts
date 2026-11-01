import { verify } from "node:crypto";
import {
  SecurityManifestSchema,
  securitySigningBytes,
  updateSigningKey,
  type SecurityManifest,
} from "@repo/core";

export function verifySecurityManifest(
  envelope: unknown,
  options: {
    now?: number;
    minimumRevision?: number;
    publicKey?: string;
    allowExpired?: boolean;
  } = {},
): SecurityManifest {
  const proof = envelope as { payload?: unknown; signature?: unknown } | null;
  if (
    typeof proof?.payload !== "string" ||
    proof.payload.length > 1_000_000 ||
    typeof proof.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature) ||
    !verify(
      null,
      Buffer.from(securitySigningBytes(proof.payload)),
      options.publicKey ?? updateSigningKey.publicKey,
      Buffer.from(proof.signature, "base64"),
    )
  ) {
    throw new Error("Security advisory signature is invalid.");
  }
  const manifest = SecurityManifestSchema.parse(JSON.parse(proof.payload));
  const now = options.now ?? Date.now();
  const issued = Date.parse(manifest.issuedAt),
    expires = Date.parse(manifest.expiresAt);
  if (
    manifest.revision < (options.minimumRevision ?? 0) ||
    issued > now + 5 * 60_000 ||
    expires <= issued ||
    expires - issued > 31 * 86_400_000 ||
    (!options.allowExpired && expires <= now)
  ) {
    throw new Error(
      "Security advisory feed is expired, from the future, or older than the accepted revision.",
    );
  }
  return manifest;
}
