import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { CommandExecutor } from "../../types";
import type { EnvironmentProfile } from "../environment";
import { profileFixture } from "../environment.fixtures";
import { reconcileServerModule } from "./reconcile";
import { readManifest } from "./on-box-manifest";
import type { ModuleVersion, VerifiedCatalog } from "./types";

const H = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

const PROFILE: EnvironmentProfile = profileFixture();

/** In-memory executor with a fake FS; `execCode` lets a test fail an exec step. */
function fakeExecutor(opts?: { execCode?: (cmd: string) => number; seed?: Record<string, string> }) {
  const files = new Map<string, string>(Object.entries(opts?.seed ?? {}));
  const executor = {
    exec: async (command: string) => {
      const m = command.match(/^sha256sum '([^']+)'/);
      if (m) {
        const p = m[1]!;
        if (!files.has(p)) throw new Error("no such file");
        return `${createHash("sha256").update(Buffer.from(files.get(p)!, "utf8")).digest("hex")}\n`;
      }
      return "";
    },
    streamExec: async (command: string) => ({ code: opts?.execCode ? opts.execCode(command) : 0, output: "" }),
    writeFile: async (p: string, c: string) => { files.set(p, c); },
    readFile: async (p: string) => { if (!files.has(p)) throw new Error("enoent"); return files.get(p)!; },
    exists: async (p: string) => files.has(p),
    mkdir: async () => {},
    rm: async (p: string) => { files.delete(p); },
  } as unknown as CommandExecutor;
  return { files, executor };
}

function verified(serial: number, latest: string, versions: ModuleVersion[], assetContents: Record<string, string>): VerifiedCatalog {
  const assets = new Map<string, Buffer>();
  for (const [k, v] of Object.entries(assetContents)) assets.set(k, Buffer.from(v, "utf8"));
  return { catalog: { module: "openresty", schema: 1, serial, latest, versions }, assets, ref: "test@abc" };
}

const luaAsset = { "a/1.0.0/rules.lua": "-- rules v1" };
const baseline: ModuleVersion = {
  version: "1.0.0",
  apply: "auto",
  steps: [{ kind: "file", id: "lua-rules", path: "/opt/rules.lua", asset: "a/1.0.0/rules.lua", sha256: H("-- rules v1") }],
};

describe("reconcileServerModule", () => {
  it("applies a fresh baseline and stamps the version", async () => {
    const { executor, files } = fakeExecutor();
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(1, "1.0.0", [baseline], luaAsset),
    });
    expect(res.ok).toBe(true);
    expect(res.appliedSteps).toEqual(["lua-rules"]);
    expect(res.toVersion).toBe("1.0.0");
    expect(files.get("/opt/rules.lua")).toBe("-- rules v1");
    const m = await readManifest(executor, "openresty");
    expect(m?.migrationVersion).toBe("1.0.0");
    expect(m?.appliedSteps).toContain("lua-rules");
    expect(m?.catalogSerial).toBe(1);
  });

  it("is idempotent on a second run (run-once)", async () => {
    const { executor } = fakeExecutor();
    const cat = verified(1, "1.0.0", [baseline], luaAsset);
    await reconcileServerModule(executor, { module: "openresty", profile: PROFILE, mode: "auto", catalog: cat });
    const second = await reconcileServerModule(executor, { module: "openresty", profile: PROFILE, mode: "auto", catalog: cat });
    // Version 1.0.0 is already the on-box migrationVersion, so it's filtered out
    // of `pending` entirely — nothing is applied OR re-examined.
    expect(second.changed).toBe(false);
    expect(second.appliedSteps).toEqual([]);
    expect(second.toVersion).toBe("1.0.0");
  });

  it("gates a consent step in auto mode and does NOT advance", async () => {
    const { executor, files } = fakeExecutor();
    const v11: ModuleVersion = {
      version: "1.1.0", apply: "auto",
      steps: [{ kind: "exec", id: "resize-rl", asset: "a/1.1.0/resize.sh", sha256: H("#!/bin/sh\ntrue\n"), apply: "consent", warning: "drops in-flight counters" }],
    };
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(2, "1.1.0", [baseline, v11], { ...luaAsset, "a/1.1.0/resize.sh": "#!/bin/sh\ntrue\n" }),
    });
    expect(res.ok).toBe(true);
    expect(res.toVersion).toBe("1.0.0"); // baseline applied, 1.1.0 gated
    expect(res.pendingConsent).toEqual([{ id: "resize-rl", version: "1.1.0", warning: "drops in-flight counters" }]);
    expect(res.appliedSteps).toEqual(["lua-rules"]);
    // exec script never written
    expect([...files.keys()].some((k) => k.includes("resize"))).toBe(false);
  });

  it("applies a consent step in mode:all and advances to latest", async () => {
    const { executor } = fakeExecutor();
    const v11: ModuleVersion = {
      version: "1.1.0", apply: "consent",
      steps: [{ kind: "exec", id: "resize-rl", asset: "a/1.1.0/resize.sh", sha256: H("#!/bin/sh\ntrue\n") }],
    };
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "all",
      catalog: verified(2, "1.1.0", [baseline, v11], { ...luaAsset, "a/1.1.0/resize.sh": "#!/bin/sh\ntrue\n" }),
    });
    expect(res.ok).toBe(true);
    expect(res.toVersion).toBe("1.1.0");
    expect(res.appliedSteps).toEqual(["lua-rules", "resize-rl"]);
    expect(res.pendingConsent).toEqual([]);
  });

  it("refuses a catalog with a serial below the on-box high-water mark", async () => {
    const { executor } = fakeExecutor();
    await reconcileServerModule(executor, { module: "openresty", profile: PROFILE, mode: "auto", catalog: verified(5, "1.0.0", [baseline], luaAsset) });
    const rollback = await reconcileServerModule(executor, { module: "openresty", profile: PROFILE, mode: "auto", catalog: verified(3, "1.0.0", [baseline], luaAsset) });
    expect(rollback.ok).toBe(false);
    expect(rollback.error).toMatch(/refusing downgrade/);
  });

  it("stops on a failed exec but persists prior steps (resume)", async () => {
    const { executor } = fakeExecutor({ execCode: () => 1 });
    const v11: ModuleVersion = {
      version: "1.1.0", apply: "auto",
      steps: [{ kind: "exec", id: "will-fail", asset: "a/1.1.0/boom.sh", sha256: H("#!/bin/sh\nexit 1\n") }],
    };
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(2, "1.1.0", [baseline, v11], { ...luaAsset, "a/1.1.0/boom.sh": "#!/bin/sh\nexit 1\n" }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/failed \(exit 1\)/);
    const m = await readManifest(executor, "openresty");
    expect(m?.migrationVersion).toBe("1.0.0"); // baseline landed, 1.1.0 did not
    expect(m?.appliedSteps).toContain("lua-rules");
    expect(m?.appliedSteps).not.toContain("will-fail");
  });

  const alpineOnly: ModuleVersion = {
    version: "1.1.0", apply: "auto",
    steps: [{ kind: "file", id: "apk-only", path: "/opt/apk.conf", asset: "a/apk.conf", sha256: H("apk"), distroFamily: ["alpine"] }],
  };

  it("skips a step filtered to another distro family", async () => {
    const { executor, files } = fakeExecutor();
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(2, "1.1.0", [baseline, alpineOnly], { ...luaAsset, "a/apk.conf": "apk" }),
    });
    expect(res.skipped).toContain("apk-only");
    expect(res.appliedSteps).not.toContain("apk-only");
    expect(files.has("/opt/apk.conf")).toBe(false);
    // version still completes (all applicable steps done) → advances
    expect(res.toVersion).toBe("1.1.0");
  });

  it("runs a family-gated step on every distro in that family", async () => {
    const rockyOnly: ModuleVersion = {
      version: "1.1.0", apply: "auto",
      steps: [{ kind: "file", id: "rpm-only", path: "/opt/rpm.conf", asset: "a/rpm.conf", sha256: H("rpm"), distroFamily: ["rhel"] }],
    };
    // Amazon Linux: a distro the old id-keyed filter had never heard of, so every
    // `distro: ["rocky", "rhel", …]` step silently skipped and the box came back "current".
    const { executor, files } = fakeExecutor();
    const res = await reconcileServerModule(executor, {
      module: "openresty",
      profile: profileFixture({ distro: "unknown", distroFamily: "rhel", distroId: "amzn", packageManager: "dnf" }),
      mode: "auto",
      catalog: verified(2, "1.1.0", [baseline, rockyOnly], { ...luaAsset, "a/rpm.conf": "rpm" }),
    });
    expect(res.ok).toBe(true);
    expect(res.appliedSteps).toContain("rpm-only");
    expect(files.get("/opt/rpm.conf")).toBe("rpm");
  });

  it("fails loudly on a family-gated step when the host's family is unknown", async () => {
    const { executor, files } = fakeExecutor();
    const res = await reconcileServerModule(executor, {
      module: "openresty",
      profile: profileFixture({ distro: "unknown", distroFamily: "unknown", distroId: "voidlinux" }),
      mode: "auto",
      catalog: verified(2, "1.1.0", [baseline, alpineOnly], { ...luaAsset, "a/apk.conf": "apk" }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("apk-only");
    expect(res.error).toContain("voidlinux");
    expect(res.error).toMatch(/unknown/);
    expect(files.has("/opt/apk.conf")).toBe(false);
    // Not silently marked converged: the version marker stays at the baseline.
    expect(res.toVersion).toBe("1.0.0");
    expect((await readManifest(executor, "openresty"))?.migrationVersion).toBe("1.0.0");
  });

  // ─── Runtime shape validation ──────────────────────────────────────────────
  // The catalog arrives as SIGNED JSON: the signature proves the author, never that a
  // value is a member of the union the runner branches on. Each case below used to pass
  // verification, match nothing, and let the version marker advance anyway.

  /** A version the TypeScript unions forbid, as it would arrive from JSON. */
  const asVersion = (raw: unknown) => raw as ModuleVersion;

  it("fails loudly on a step whose distroFamily is not a family, instead of skipping it", async () => {
    const { executor, files } = fakeExecutor();
    // "redhat" is the os-release ID spelling; the family member is "rhel".
    const typo = asVersion({
      version: "1.1.0", apply: "auto",
      steps: [{ kind: "file", id: "rpm-only", path: "/opt/rpm.conf", asset: "a/rpm.conf", sha256: H("rpm"), distroFamily: ["redhat"] }],
    });
    const res = await reconcileServerModule(executor, {
      module: "openresty",
      profile: profileFixture({ distro: "rocky", distroFamily: "rhel", distroId: "rocky", packageManager: "dnf" }),
      mode: "auto",
      catalog: verified(2, "1.1.0", [baseline, typo], { ...luaAsset, "a/rpm.conf": "rpm" }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("redhat");
    expect(res.error).toContain("rhel");
    expect(res.skipped).not.toContain("rpm-only");
    expect(files.has("/opt/rpm.conf")).toBe(false);
    // The marker stays at the baseline: nothing in 1.1.0 ran, so nothing claims it did.
    expect(res.toVersion).toBe("1.0.0");
    expect((await readManifest(executor, "openresty"))?.migrationVersion).toBe("1.0.0");
  });

  it("fails a version whose step declares a tier that isn't a tier", async () => {
    const { executor } = fakeExecutor();
    // Anything that isn't "consent" reads as "not consent" — i.e. it would run unattended.
    const badTier = asVersion({
      version: "1.1.0", apply: "auto",
      steps: [{ kind: "exec", id: "unattended", asset: "a/x.sh", sha256: H("x"), apply: "automatic" }],
    });
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(2, "1.1.0", [baseline, badTier], { ...luaAsset, "a/x.sh": "x" }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("automatic");
    expect(res.appliedSteps).not.toContain("unattended");
    expect((await readManifest(executor, "openresty"))?.migrationVersion).toBe("1.0.0");
  });

  it("fails a step whose kind the runner cannot execute", async () => {
    const { executor } = fakeExecutor();
    const unknownKind = asVersion({
      version: "1.1.0", apply: "auto",
      steps: [{ kind: "systemd-unit", id: "future", asset: "a/x.sh", sha256: H("x") }],
    });
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(2, "1.1.0", [baseline, unknownKind], { ...luaAsset, "a/x.sh": "x" }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("systemd-unit");
  });

  it("applies the valid versions before a malformed one and stops there", async () => {
    const { executor } = fakeExecutor();
    const v11: ModuleVersion = {
      version: "1.1.0", apply: "auto",
      steps: [{ kind: "file", id: "ok-step", path: "/opt/ok.conf", asset: "a/ok.conf", sha256: H("ok") }],
    };
    const v12 = asVersion({ version: "1.2.0", apply: "auto", steps: [{ kind: "file", id: "no-path", asset: "a/ok.conf", sha256: H("ok") }] });
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(2, "1.2.0", [baseline, v11, v12], { ...luaAsset, "a/ok.conf": "ok" }),
    });
    expect(res.ok).toBe(false);
    expect(res.appliedSteps).toEqual(["lua-rules", "ok-step"]);
    // 1.1.0 fully applied → stamped; 1.2.0 never started.
    expect((await readManifest(executor, "openresty"))?.migrationVersion).toBe("1.1.0");
  });

  it("refuses a catalog whose latest cannot be ordered", async () => {
    const { executor, files } = fakeExecutor();
    // compareSemver reads "banana" as 0.0.0, so every version sorts above `latest` and
    // the pending set comes out empty — a converged-looking no-op.
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(1, "banana", [baseline], luaAsset),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("banana");
    expect(files.has("/opt/rules.lua")).toBe(false);
  });

  it("refuses a catalog version that cannot be ordered instead of dropping it", async () => {
    const { executor } = fakeExecutor();
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(1, "1.0.0", [asVersion({ ...baseline, version: "1.0" })], luaAsset),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("1.0");
    expect(res.appliedSteps).toEqual([]);
  });

  it("fails a family-gated step when the host's family is a value we cannot name", async () => {
    const { executor } = fakeExecutor();
    // Not "unknown" but a value outside the union entirely — what an os-release ID that
    // resolves through no map (or names an Object.prototype key) arrives as.
    const foreignFamily = {
      ...profileFixture({ distro: "unknown", distroId: "redhat" }),
      distroFamily: "redhat",
    } as unknown as EnvironmentProfile;
    const res = await reconcileServerModule(executor, {
      module: "openresty",
      profile: foreignFamily,
      mode: "auto",
      catalog: verified(2, "1.1.0", [baseline, alpineOnly], { ...luaAsset, "a/apk.conf": "apk" }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("apk-only");
    expect(res.error).toContain("redhat");
    expect(res.skipped).not.toContain("apk-only");
  });

  it("dry-run reports a shape failure rather than a clean no-op", async () => {
    const { executor } = fakeExecutor();
    const typo = asVersion({
      version: "1.1.0", apply: "auto",
      steps: [{ kind: "file", id: "rpm-only", path: "/opt/rpm.conf", asset: "a/rpm.conf", sha256: H("rpm"), distroFamily: ["redhat"] }],
    });
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto", dryRun: true,
      catalog: verified(2, "1.1.0", [baseline, typo], { ...luaAsset, "a/rpm.conf": "rpm" }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("redhat");
  });

  it("dry-run writes nothing and does not persist the manifest", async () => {
    const { executor, files } = fakeExecutor();
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto", dryRun: true,
      catalog: verified(1, "1.0.0", [baseline], luaAsset),
    });
    expect(res.appliedSteps).toEqual(["lua-rules"]);
    expect(files.has("/opt/rules.lua")).toBe(false);
    expect(await readManifest(executor, "openresty")).toBeNull();
  });

  it("seeds a baseline when the legacy marker exists (no replay)", async () => {
    const { executor, files } = fakeExecutor({ seed: { "/legacy/.openship-lua-version": "deadbeef" } });
    const res = await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(1, "1.0.0", [baseline], luaAsset),
      seed: { legacyMarkerPath: "/legacy/.openship-lua-version", baselineVersion: "1.0.0" },
    });
    expect(res.changed).toBe(false);
    expect(res.appliedSteps).toEqual([]);
    expect(files.has("/opt/rules.lua")).toBe(false); // baseline assumed, not rewritten
  });

  it("runs the postApply hook once after a change", async () => {
    const { executor } = fakeExecutor();
    let hooks = 0;
    await reconcileServerModule(executor, {
      module: "openresty", profile: PROFILE, mode: "auto",
      catalog: verified(1, "1.0.0", [baseline], luaAsset),
      postApply: async () => { hooks += 1; },
    });
    expect(hooks).toBe(1);
  });
});
