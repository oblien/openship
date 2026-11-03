import { expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { legacySecurityAdvisories, signSecurityAdvisories } from "./sign-security-advisories";
import { SecurityManifestSchema } from "../packages/core/src/updates/security";
import source from "../security-advisories.json";

it("publishes legacy-safe notices without broadening host or mode-scoped instructions", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const base = source.advisories[0]!;
  const signed = signSecurityAdvisories(
    {
      ...source,
      advisories: [
        base,
        { ...base, id: "self-only", modes: ["selfhosted"] },
        {
          ...base,
          id: "host",
          action: "patch-host",
          targets: [
            {
              kind: "host-package",
              distribution: "ubuntu",
              release: "24.04",
              package: "openssl",
              fixedVersion: "3.0.13-0ubuntu3.16",
            },
          ],
        },
      ],
    },
    privatePem,
    publicPem,
  );
  const manifest = SecurityManifestSchema.parse(JSON.parse(signed.payload));
  const legacy = legacySecurityAdvisories(manifest);
  expect(legacy.advisories).toEqual([base]);
  expect(manifest.advisories).toHaveLength(3);
  expect(legacy.revision).toBe(manifest.revision);
  const legacySigned = signSecurityAdvisories(legacy, privatePem, publicPem, manifest.revision);
  expect(JSON.parse(legacySigned.payload).expiresAt).toBe(manifest.expiresAt);
});
