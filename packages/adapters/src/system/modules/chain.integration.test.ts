import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { CommandExecutor } from "../../types";
import type { EnvironmentProfile } from "../environment";
import { verifyAndBuild } from "./catalog-source";
import { reconcileServerModule } from "./reconcile";
import { readManifest } from "./on-box-manifest";

/**
 * End-to-end trust + apply chain against the REAL bundled OpenResty catalog:
 * read the shipped catalog.json + assets → sign with a test key → verify (sig +
 * asset sha256) → reconcile applies the pending migration on a box seeded at the
 * baseline → the on-box manifest advances atomically to the new version. This is
 * the per-release chain the whole feature rests on.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OR_DIR = join(HERE, "catalog", "openresty");

const PROFILE: EnvironmentProfile = {
  os: "linux", arch: "amd64", distro: "ubuntu",
  packageManager: "apt", serviceManager: "systemd", isRoot: true, canSudo: false,
};

function fakeExecutor(seed: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    exec: async (command: string) => {
      const m = command.match(/^sha256sum '([^']+)'/);
      if (m) {
        const p = m[1]!;
        if (!files.has(p)) throw new Error("enoent");
        return `${createHash("sha256").update(Buffer.from(files.get(p)!, "utf8")).digest("hex")}\n`;
      }
      return "";
    },
    streamExec: async () => ({ code: 0, output: "" }),
    writeFile: async (p: string, c: string) => { files.set(p, c); },
    readFile: async (p: string) => { if (!files.has(p)) throw new Error("enoent"); return files.get(p)!; },
    exists: async (p: string) => files.has(p),
    mkdir: async () => {},
    rm: async (p: string) => { files.delete(p); },
  } as unknown as CommandExecutor;
}

describe("catalog chain (real OpenResty catalog)", () => {
  it("signs → verifies → reconciles the shipped 1.1.0 migration atomically", async () => {
    const manifestBytes = readFileSync(join(OR_DIR, "catalog.json"));
    const scriptBytes = readFileSync(join(OR_DIR, "assets", "1.1.0", "resize-rl-counters.sh"));

    // Sign with a throwaway key standing in for the offline release key.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const sig = cryptoSign(null, manifestBytes, privateKey);

    const assets = new Map([["assets/1.1.0/resize-rl-counters.sh", scriptBytes]]);
    const built = verifyAndBuild("openresty", manifestBytes, sig, assets, "test-ref", [pub]);
    expect(built.error).toBeUndefined();
    expect(built.catalog?.catalog.latest).toBe("1.1.0");

    // Box seeded at baseline 1.0.0 via the legacy lua marker → 1.1.0 pending.
    const marker = "/usr/local/openresty/site/lualib/openship/.openship-lua-version";
    const executor = fakeExecutor({ [marker]: "deadbeef" });

    // auto mode: the migration is consent-tier → gated, nothing applied.
    const auto = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, catalog: built.catalog!, mode: "auto",
      seed: { legacyMarkerPath: marker, baselineVersion: "1.0.0" },
    });
    expect(auto.pendingConsent.map((c) => c.id)).toContain("resize-rl-counters-16m-to-32m");
    expect(auto.toVersion).toBe("1.0.0"); // not advanced

    // all mode: operator applies → advances to 1.1.0, recorded run-once.
    const all = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, catalog: built.catalog!, mode: "all",
      seed: { legacyMarkerPath: marker, baselineVersion: "1.0.0" },
    });
    expect(all.ok).toBe(true);
    expect(all.toVersion).toBe("1.1.0");
    expect(all.appliedSteps).toContain("resize-rl-counters-16m-to-32m");

    const manifest = await readManifest(executor, "openresty");
    expect(manifest?.migrationVersion).toBe("1.1.0");
    expect(manifest?.catalogSerial).toBe(1);

    // Re-run is a no-op (run-once): already at latest.
    const again = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, catalog: built.catalog!, mode: "all",
      seed: { legacyMarkerPath: marker, baselineVersion: "1.0.0" },
    });
    expect(again.changed).toBe(false);
  });

  it("rejects the real catalog when the signature is from the wrong key", () => {
    const manifestBytes = readFileSync(join(OR_DIR, "catalog.json"));
    const scriptBytes = readFileSync(join(OR_DIR, "assets", "1.1.0", "resize-rl-counters.sh"));
    const signer = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    const sig = cryptoSign(null, manifestBytes, signer.privateKey);
    const attackerPub = attacker.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const built = verifyAndBuild(
      "openresty", manifestBytes, sig,
      new Map([["assets/1.1.0/resize-rl-counters.sh", scriptBytes]]),
      "test-ref", [attackerPub],
    );
    expect(built.error).toMatch(/signature verification failed/);
  });
});
