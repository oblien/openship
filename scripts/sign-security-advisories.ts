import { readFile, writeFile } from "node:fs/promises";
import { createPublicKey, sign } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SecurityManifestSchema,
  securitySigningBytes,
  type SecurityManifest,
} from "../packages/core/src/updates/security";
import trust from "../packages/core/src/updates/signing-public-key.json";

/** Older clients reject unknown targets and fields. Never broaden a scoped notice. */
export function legacySecurityAdvisories(source: SecurityManifest): SecurityManifest {
  return {
    ...source,
    advisories: source.advisories.filter(
      (a) =>
        !a.modes && a.action !== "patch-host" && a.targets.every((t) => t.kind !== "host-package"),
    ),
  };
}

/** Reusable by the publisher and integration tests; private keys never leave the signer. */
export function signSecurityAdvisories(
  source: object,
  privateKey: string,
  publicKey = trust.publicKey,
  now = Date.now(),
) {
  const manifest = SecurityManifestSchema.parse({
    ...source,
    format: 1,
    revision: now,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 14 * 86_400_000).toISOString(),
  });
  const actualKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  if (actualKey.trim() !== publicKey.trim())
    throw new Error("Signing key does not match the public advisory trust root.");
  const payload = JSON.stringify(manifest);
  return {
    payload,
    signature: sign(null, Buffer.from(securitySigningBytes(payload)), privateKey).toString(
      "base64",
    ),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const source = JSON.parse(
    await readFile(new URL("../security-advisories.json", import.meta.url), "utf8"),
  );
  const privateKey = process.env.OPENSHIP_DESKTOP_SIGNING_KEY;
  if (!privateKey) throw new Error("OPENSHIP_DESKTOP_SIGNING_KEY is required.");
  const signed = signSecurityAdvisories(source, privateKey);
  await writeFile(
    process.argv[2] ?? "security-advisories.v2.signed.json",
    JSON.stringify(signed) + "\n",
  );
  if (process.argv[3]) {
    const manifest = JSON.parse(signed.payload) as SecurityManifest;
    await writeFile(
      process.argv[3],
      JSON.stringify(
        signSecurityAdvisories(
          legacySecurityAdvisories(manifest),
          privateKey,
          trust.publicKey,
          manifest.revision,
        ),
      ) + "\n",
    );
  }
}
