/**
 * "Backup before each deploy" has to fire on EVERY deploy, exactly ONCE.
 *
 * Both halves were wrong. The trigger was reachable only from
 * `redeployBuildSession` behind a `preDeployBackup` opt-in that only the
 * app-update path passed, so an ordinary deploy — the button, a webhook push, a
 * CLI deploy — never consulted `trigger_on_pre_deploy` policies at all: the one
 * safety net an operator switches on precisely because something is about to
 * change did not run, and nothing said so. Once the hook moved to the shared
 * funnel in `executeBuildAndDeploy`, that leftover opt-in became a DUPLICATE —
 * two runs per policy for one cutover, two artifacts against the destination and
 * the retention window.
 *
 * So this file pins the wiring as well as the behaviour. The behaviour tests can
 * pass while the hook sits on a path no deploy takes (that is exactly what
 * happened), and the wiring is the part a unit test of the function cannot see.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  policies: [] as Array<{ id: string; createdBy: string | null }>,
  /** Policy ids whose enqueue must throw, to exercise the per-policy catch. */
  failFor: new Set<string>(),
  listThrows: false,
  enqueued: [] as Array<{ policyId: string; source: string; userId: string }>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    backupPolicy: {
      listEnabledPreDeployByProject: async () => {
        if (h.listThrows) throw new Error("db is down");
        return h.policies;
      },
    },
  },
}));

vi.mock("../../../src/modules/backups/backup.orchestrator", () => ({
  backupOrchestrator: {
    enqueue: async (input: { policyId: string; trigger: { source: string; userId: string } }) => {
      if (h.failFor.has(input.policyId)) throw new Error("destination unreachable");
      h.enqueued.push({
        policyId: input.policyId,
        source: input.trigger.source,
        userId: input.trigger.userId,
      });
      return { runId: `bkr_${input.policyId}`, runIds: [`bkr_${input.policyId}`] };
    },
  },
}));

import { firePreDeployBackups } from "../../../src/modules/backups/triggers/pre-deploy";

const API_SRC = join(__dirname, "../../../src");
const read = (rel: string): string => readFileSync(join(API_SRC, rel), "utf8");

beforeEach(() => {
  h.policies = [];
  h.failFor = new Set();
  h.listThrows = false;
  h.enqueued = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("firePreDeployBackups", () => {
  it("enqueues one pre_deploy run per enabled policy, attributed to its creator", async () => {
    h.policies = [
      { id: "pol_db", createdBy: "usr_alice" },
      { id: "pol_files", createdBy: "usr_bob" },
    ];

    const result = await firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" });

    expect(result).toEqual({ enqueued: 2, failed: 0 });
    expect(h.enqueued).toEqual([
      { policyId: "pol_db", source: "pre_deploy", userId: "usr_alice" },
      { policyId: "pol_files", source: "pre_deploy", userId: "usr_bob" },
    ]);
  });

  it("falls back to 'system' when the policy has no creator", async () => {
    h.policies = [{ id: "pol_orphan", createdBy: null }];

    await firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" });

    expect(h.enqueued[0]?.userId).toBe("system");
  });

  it("one policy's failure never costs the others their backup", async () => {
    h.policies = [
      { id: "pol_a", createdBy: "usr_alice" },
      { id: "pol_broken", createdBy: "usr_alice" },
      { id: "pol_c", createdBy: "usr_alice" },
    ];
    h.failFor = new Set(["pol_broken"]);

    const result = await firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" });

    expect(result).toEqual({ enqueued: 2, failed: 1 });
    expect(h.enqueued.map((e) => e.policyId)).toEqual(["pol_a", "pol_c"]);
  });

  it("resolves instead of throwing when the policies cannot even be read", async () => {
    // The caller is in the middle of a deploy. A backup that cannot be enqueued
    // must degrade to "no backup", never to a failed deploy.
    h.listThrows = true;

    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" }),
    ).resolves.toEqual({ enqueued: 0, failed: 0 });
  });
});

describe("deploy wiring", () => {
  it("is called from the shared build→deploy funnel, and from nowhere else", () => {
    const callers = [
      "modules/deployments/build-pipeline.ts",
      "modules/deployments/build.service.ts",
      "modules/deployments/compose/deploy.service.ts",
      "modules/updates/updates.service.ts",
    ].filter((rel) => /firePreDeployBackups\s*\(/.test(read(rel)));

    expect(callers).toEqual(["modules/deployments/build-pipeline.ts"]);
  });

  it("fires once per deploy, before the mode branch and before the build", () => {
    const src = read("modules/deployments/build-pipeline.ts");
    const calls = src.match(/firePreDeployBackups\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const hook = src.indexOf("firePreDeployBackups(");
    // The compose/single-app split, and the first thing either branch does. A
    // hook after either one is the bug this file exists for: inside the branch it
    // misses the other mode, after the build it races the cutover it is meant to
    // precede.
    const modeBranch = src.indexOf("if (useServicePipeline && isMultiServiceRuntime(runtime))");
    const composeBuild = src.indexOf("await executeComposePipeline(");
    expect(modeBranch).toBeGreaterThan(-1);
    expect(composeBuild).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(modeBranch);
    expect(hook).toBeLessThan(composeBuild);
  });

  it("no deploy entry point carries a pre-deploy opt-in of its own", () => {
    // `redeployBuildSession(..., { preDeployBackup: true })` was the old opt-in.
    // Re-introducing a flag like it means one entry point backs up twice and the
    // rest are back to relying on a caller remembering.
    expect(read("modules/deployments/build.service.ts")).not.toMatch(/preDeployBackup/);
    expect(read("modules/updates/updates.service.ts")).not.toMatch(/preDeployBackup/);
  });
});
