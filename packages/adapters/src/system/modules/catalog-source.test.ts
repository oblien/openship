import { describe, it, expect, afterEach } from "vitest";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { verifyAndBuild } from "./catalog-source";
import type { ModuleCatalog } from "./types";

const H = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

function key() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ format: "der", type: "spki" }).toString("base64"), privateKey };
}

const SCRIPT = "#!/bin/sh\ntrue\n";
function manifest(): ModuleCatalog {
  return {
    module: "openresty",
    schema: 1,
    serial: 1,
    latest: "1.0.0",
    versions: [
      { version: "1.0.0", apply: "auto", steps: [{ kind: "exec", id: "s1", asset: "a/s1.sh", sha256: H(SCRIPT) }] },
    ],
  };
}

afterEach(() => {
  delete process.env.OPENSHIP_MODULE_CATALOG_INSECURE;
});

describe("verifyAndBuild", () => {
  it("accepts a correctly signed catalog with matching asset hashes", () => {
    const { pub, privateKey } = key();
    const bytes = Buffer.from(JSON.stringify(manifest()));
    const sig = cryptoSign(null, bytes, privateKey);
    const assets = new Map([["a/s1.sh", Buffer.from(SCRIPT)]]);
    const res = verifyAndBuild("openresty", bytes, sig, assets, "ref", [pub]);
    expect(res.error).toBeUndefined();
    expect(res.catalog?.catalog.latest).toBe("1.0.0");
    expect(res.catalog?.assets.get("a/s1.sh")?.toString()).toBe(SCRIPT);
  });

  it("rejects a bad signature", () => {
    const signer = key();
    const other = key();
    const bytes = Buffer.from(JSON.stringify(manifest()));
    const sig = cryptoSign(null, bytes, signer.privateKey);
    const res = verifyAndBuild("openresty", bytes, sig, new Map([["a/s1.sh", Buffer.from(SCRIPT)]]), "ref", [other.pub]);
    expect(res.error).toMatch(/signature verification failed/);
  });

  it("rejects a tampered asset even with a valid signature", () => {
    const { pub, privateKey } = key();
    const bytes = Buffer.from(JSON.stringify(manifest()));
    const sig = cryptoSign(null, bytes, privateKey);
    const res = verifyAndBuild("openresty", bytes, sig, new Map([["a/s1.sh", Buffer.from("TAMPERED")]]), "ref", [pub]);
    expect(res.error).toMatch(/asset verification failed/);
  });

  it("rejects a module-name mismatch", () => {
    const { pub, privateKey } = key();
    const bytes = Buffer.from(JSON.stringify(manifest()));
    const sig = cryptoSign(null, bytes, privateKey);
    const res = verifyAndBuild("certbot", bytes, sig, new Map([["a/s1.sh", Buffer.from(SCRIPT)]]), "ref", [pub]);
    expect(res.error).toMatch(/module mismatch/);
  });

  it("insecure hatch (non-prod) bypasses signature + hash", () => {
    process.env.OPENSHIP_MODULE_CATALOG_INSECURE = "1";
    const bytes = Buffer.from(JSON.stringify(manifest()));
    // empty keyring + wrong asset — would fail if verification ran
    const res = verifyAndBuild("openresty", bytes, Buffer.alloc(0), new Map(), "ref", []);
    expect(res.error).toBeUndefined();
    expect(res.catalog?.catalog.module).toBe("openresty");
  });
});
