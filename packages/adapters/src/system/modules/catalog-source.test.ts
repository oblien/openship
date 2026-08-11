import { describe, it, expect, afterEach } from "vitest";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { verifyAndBuild, fetchRemoteCatalog } from "./catalog-source";
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

/** Sign `body` and run it through verifyAndBuild with a trusted throwaway key. */
function build(body: unknown, assets = new Map([["a/s1.sh", Buffer.from(SCRIPT)]])) {
  const { pub, privateKey } = key();
  const bytes = Buffer.from(JSON.stringify(body));
  return verifyAndBuild("openresty", bytes, cryptoSign(null, bytes, privateKey), assets, "ref", [pub]);
}

describe("verifyAndBuild shape refusals", () => {
  // A signature authenticates the author, not the values: pre-guard each of these
  // threw a raw TypeError from inside the referencedAssets/expectedAssetHashes walk.
  it("refuses a non-array versions, naming the field and value", () => {
    const res = build({ ...manifest(), versions: null });
    expect(res.catalog).toBeUndefined();
    expect(res.error).toBe("invalid catalog: catalog versions must be an array (got null)");
  });

  it("refuses a step that is not an object", () => {
    const res = build({
      ...manifest(),
      versions: [{ version: "1.0.0", apply: "auto", steps: ["rm -rf /"] }],
    });
    expect(res.error).toBe('invalid catalog: version "1.0.0": step is not an object (got "rm -rf /")');
  });

  it("refuses a newer schema BEFORE assembling a verified catalog", () => {
    const res = build({ ...manifest(), schema: 2 });
    expect(res.catalog).toBeUndefined();
    expect(res.error).toBe("invalid catalog: catalog schema must be 1 (got 2)");
  });

  it("refuses a malformed manifest even under the insecure hatch", () => {
    process.env.OPENSHIP_MODULE_CATALOG_INSECURE = "1";
    const bytes = Buffer.from(JSON.stringify({ ...manifest(), versions: null }));
    const res = verifyAndBuild("openresty", bytes, Buffer.alloc(0), new Map(), "ref", []);
    expect(res.error).toMatch(/invalid catalog: catalog versions must be an array/);
  });

  it("refuses a non-object manifest without dereferencing it", () => {
    const res = build(null);
    expect(res.error).toBe("invalid catalog: catalog is not an object (got null)");
  });
});

describe("fetchRemoteCatalog shape refusals", () => {
  // Assigned, not vi.stubGlobal: this file also runs under `bun test`, whose vitest
  // shim has no stubGlobal.
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses a malformed remote manifest instead of walking it for assets", async () => {
    const body = JSON.stringify({ ...manifest(), versions: [{ version: "1.0.0", apply: "auto", steps: 7 }] });
    const fetched: string[] = [];
    globalThis.fetch = (async (url: string) => {
      fetched.push(url);
      if (url.endsWith("catalog.json")) {
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;
    const res = await fetchRemoteCatalog("openresty");
    expect(res.catalog).toBeUndefined();
    expect(res.error).toBe(
      'remote manifest invalid: version "1.0.0": steps must be an array (got 7)',
    );
    // Nothing beyond the manifest + its signature was fetched.
    expect(fetched.every((u) => u.endsWith("catalog.json") || u.endsWith("catalog.json.sig"))).toBe(true);
  });
});
