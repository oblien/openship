import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { securitySigningBytes } from "@repo/core";
import { verifySecurityManifest } from "@repo/platform/engine/modules/updates/security-signature";
import { parseRuntimeProbe } from "@repo/platform/engine/modules/updates/runtime-probes";
import { signSecurityAdvisories } from "../../../../../scripts/sign-security-advisories";
import publicNotices from "../../../../../security-advisories.json";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const now = Date.now();
const manifest = {
  format: 1,
  revision: 5,
  issuedAt: new Date(now - 1000).toISOString(),
  expiresAt: new Date(now + 100_000).toISOString(),
  advisories: [],
};
const envelope = (value: unknown) => {
  const payload = JSON.stringify(value);
  return {
    payload,
    signature: sign(null, Buffer.from(securitySigningBytes(payload)), keys.privateKey).toString(
      "base64",
    ),
  };
};

describe("security feed verification", () => {
  it("publishes the actual public source in the envelope clients verify", () => {
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const published = signSecurityAdvisories(publicNotices, privateKey, publicKey, now);
    const received = verifySecurityManifest(published, { now, publicKey });
    expect(received.advisories.map((item) => item.id)).toEqual(
      publicNotices.advisories.map((item) => item.id),
    );
    expect(received.revision).toBe(now);
    expect(Date.parse(received.expiresAt) - now).toBe(14 * 86_400_000);
    expect(() => signSecurityAdvisories(publicNotices, privateKey)).toThrow(/trust root/);
    expect(() =>
      signSecurityAdvisories({ ...publicNotices, command: "remote shell" }, privateKey, publicKey),
    ).toThrow();
  });
  it("accepts signed metadata but rejects tampering, another key and rollback", () => {
    const proof = envelope(manifest);
    expect(verifySecurityManifest(proof, { now, publicKey, minimumRevision: 4 })).toEqual(manifest);
    expect(() =>
      verifySecurityManifest(
        { ...proof, payload: proof.payload.replace('"revision":5', '"revision":6') },
        { now, publicKey },
      ),
    ).toThrow();
    expect(() => verifySecurityManifest(proof, { now })).toThrow();
    expect(() => verifySecurityManifest(proof, { now, publicKey, minimumRevision: 6 })).toThrow();
  });
  it("keeps expired notices readable without allowing them to authorize an update", () => {
    const proof = envelope({
      ...manifest,
      issuedAt: new Date(now - 10000).toISOString(),
      expiresAt: new Date(now - 1).toISOString(),
    });
    expect(() => verifySecurityManifest(proof, { now, publicKey })).toThrow();
    expect(verifySecurityManifest(proof, { now, publicKey, allowExpired: true }).revision).toBe(5);
    expect(() =>
      verifySecurityManifest(
        envelope({ ...manifest, issuedAt: new Date(now + 600_000).toISOString() }),
        { now, publicKey },
      ),
    ).toThrow();
  });
  it("parses fixed runtime probes without accepting shell-like output as a version", () => {
    expect(
      parseRuntimeProbe(
        "OPENSHIP_RUNTIME_node\nv22.23.4\nOPENSHIP_RUNTIME_php\nPHP 8.4.2 (cli)\nOPENSHIP_RUNTIME_bun\n1.4.4\n",
        "service",
      ).map((row) => [row.runtime, row.version]),
    ).toEqual([
      ["node", "22.23.4"],
      ["bun", "1.4.4"],
      ["php", "8.4.2"],
    ]);
    expect(parseRuntimeProbe("OPENSHIP_RUNTIME_node\n$(cat /etc/passwd)", "service")).toEqual([]);
    expect(
      parseRuntimeProbe("OPENSHIP_RUNTIME_go\ngo version go1.25.3 linux/amd64", "service"),
    ).toEqual([{ serviceId: "service", runtime: "go", version: "1.25.3" }]);
    expect(
      parseRuntimeProbe(
        "OPENSHIP_RUNTIME_node\nv22.23.4-rc.1\nOPENSHIP_RUNTIME_deno\ndeno 2.4.0-rc.1\nv8 13.9.1\n",
        "service",
      ),
    ).toEqual([]);
  });
});
