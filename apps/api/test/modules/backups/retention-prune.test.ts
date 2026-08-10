/**
 * D7: retention was configured everywhere and enforced nowhere.
 *
 * Two independent bugs, either one enough to fill a destination:
 *
 *  1. `createPolicy` wrote `retainCount: null, retainDays: null` — the only two
 *     fields on that insert with neither an API default nor a column default. The
 *     prune short-circuits on "no retention configured", so every policy created
 *     over the API or MCP kept every run forever, while the same policy created
 *     in the dashboard (whose form defaults to 7) pruned normally.
 *  2. The sweep walked `listEnabledScheduled()` — `cron_expression IS NOT NULL` —
 *     on the theory that a cron-less policy is manual-only and its owner opted
 *     into fire-and-forget. But `trigger_on_pre_deploy` and the inbound webhook
 *     both produce runs automatically with no cron at all. Those policies grew
 *     without a ceiling even with `retain_count` explicitly set, which is the one
 *     case where the operator had asked for one.
 *
 * "Keep everything" is still reachable — it just has to be asked for now, and
 * every skip is logged instead of silent.
 */

import { DEFAULT_RETAIN_COUNT } from "@repo/core";
import { db, repos, schema } from "@repo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Artifact keys the destination was asked to delete, in call order. */
  deleted: [] as string[],
  syncPolicySchedule: vi.fn(),
}));

vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/adapters")>()),
  resolveDestination: () => ({
    deleteMany: async (keys: string[]) => {
      h.deleted.push(...keys);
    },
  }),
}));

// Registering a real cron schedule is the JobRunner's business, not retention's.
vi.mock("../../../src/modules/backups/triggers/cron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/backups/triggers/cron")>()),
  syncPolicySchedule: h.syncPolicySchedule,
}));

import { createPolicy } from "../../../src/modules/backups/backup.service";
import { prunePolicy, runRetentionSweep } from "../../../src/modules/backups/retention-prune";
import {
  seedBackupDestination,
  seedBackupPolicy,
  seedBackupRun,
  seedOrg,
  seedProject,
  seedService,
} from "../../helpers/seed";

const ctx = (organizationId: string, userId: string) => ({ organizationId, userId }) as never;

let organizationId: string;
let userId: string;
let projectId: string;
let destinationId: string;

beforeEach(async () => {
  h.deleted.length = 0;
  vi.clearAllMocks();
  // The PGlite instance is per FILE, and the sweep walks every policy on the
  // instance — so a leftover policy from the previous test is a real row it
  // would legitimately prune. Clear them, not just the org.
  await db.delete(schema.backupRun);
  await db.delete(schema.backupPolicy);
  const org = await seedOrg();
  organizationId = org.organizationId;
  userId = org.userId;
  projectId = (await seedProject(organizationId)).id;
  destinationId = (await seedBackupDestination(organizationId)).id;
});

/** `count` succeeded runs, `artifact-0` oldest through `artifact-N` newest. */
async function seedRuns(
  policyId: string,
  count: number,
  over: Partial<Parameters<typeof seedBackupRun>[1]> = {},
) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(
      await seedBackupRun(organizationId, {
        policyId,
        projectId,
        destinationId,
        status: "succeeded",
        finishedAt: new Date(Date.UTC(2026, 0, 1 + i)),
        artifacts: [{ key: `artifact-${i}.tar` }],
        ...over,
      }),
    );
  }
  return rows;
}

describe("retention defaults", () => {
  it("gives a policy created over the API a retention window", async () => {
    // The bug: two nulls here meant the prune skipped this policy forever.
    const policy = await createPolicy(ctx(organizationId, userId), {
      projectId,
      serviceId: null,
      destinationId,
    });
    expect(policy.retainCount).toBe(DEFAULT_RETAIN_COUNT);
  });

  it("leaves a day-based window alone rather than adding a count to it", async () => {
    // `retainDays` alone is a complete retention config. Defaulting a count on
    // top of it would silently tighten a window the operator chose.
    const policy = await createPolicy(ctx(organizationId, userId), {
      projectId,
      serviceId: null,
      destinationId,
      retainDays: 30,
    });
    expect(policy.retainCount).toBeNull();
    expect(policy.retainDays).toBe(30);
  });

  it("still lets a caller ask for unlimited", async () => {
    const policy = await createPolicy(ctx(organizationId, userId), {
      projectId,
      serviceId: null,
      destinationId,
      retainCount: null,
    });
    expect(policy.retainCount).toBeNull();
  });

  it("applies the column default to an insert that omits retention entirely", async () => {
    // The default lives on the column, not only in the service, so another
    // insert path can't reintroduce the bug by forgetting the fallback. It is
    // also what makes a surviving NULL row mean "unlimited" unambiguously.
    const policy = await seedBackupPolicy(destinationId, { projectId });
    expect(policy.retainCount).toBe(DEFAULT_RETAIN_COUNT);
  });
});

describe("runRetentionSweep policy selection", () => {
  it("prunes a cron-less policy that auto-triggers on pre-deploy", async () => {
    // The second bug. This policy fires on every deploy and had a ceiling set;
    // the cron filter meant it was never swept.
    const policy = await seedBackupPolicy(destinationId, {
      projectId,
      enabled: true,
      cronExpression: null,
      triggerOnPreDeploy: true,
      retainCount: 2,
    });
    await seedRuns(policy.id, 5);

    const stats = await runRetentionSweep();

    expect(stats.runsDeleted).toBe(3);
    expect(stats.policiesProcessed).toBe(1);
    expect([...h.deleted].sort()).toEqual([
      "artifact-0.tar",
      "artifact-1.tar",
      "artifact-2.tar",
    ]);
  });

  it("prunes a cron-less webhook-triggered policy", async () => {
    const policy = await seedBackupPolicy(destinationId, {
      projectId,
      enabled: true,
      cronExpression: null,
      webhookToken: "whk_test_token",
      retainCount: 1,
    });
    await seedRuns(policy.id, 3);

    const stats = await runRetentionSweep();
    expect(stats.runsDeleted).toBe(2);
  });

  it("skips a disabled policy", async () => {
    const policy = await seedBackupPolicy(destinationId, {
      projectId,
      enabled: false,
      retainCount: 1,
    });
    await seedRuns(policy.id, 4);

    const stats = await runRetentionSweep();
    expect(stats.runsDeleted).toBe(0);
    expect(h.deleted).toEqual([]);
  });

  it("leaves an explicitly unlimited policy untouched", async () => {
    const policy = await seedBackupPolicy(destinationId, {
      projectId,
      enabled: true,
      retainCount: null,
      retainDays: null,
    });
    await seedRuns(policy.id, 4);

    const stats = await runRetentionSweep();
    expect(stats.runsDeleted).toBe(0);
    // Not even visited: the query excludes it, so there is no daily warning
    // about a choice the operator made on purpose.
    expect(stats.policiesProcessed + stats.policiesSkipped).toBe(0);
  });
});

describe("prunePolicy", () => {
  it("drops the runs outside the window and soft-deletes their rows", async () => {
    const policy = await seedBackupPolicy(destinationId, { projectId, retainCount: 2 });
    const runs = await seedRuns(policy.id, 4);

    const outcome = await prunePolicy(policy);

    expect(outcome).toEqual({ dropped: 2, skipped: null });
    // The row goes too — an artifact-less row would advertise a restorable
    // backup whose bytes are gone.
    expect((await repos.backupRun.findById(runs[0]!.id))?.deletedAt).toBeTruthy();
    expect((await repos.backupRun.findById(runs[3]!.id))?.deletedAt).toBeNull();
  });

  it("reports WHY it did nothing instead of returning a bare zero", async () => {
    // Silence is what let "retention is on" and "retention runs" diverge.
    const policy = await seedBackupPolicy(destinationId, {
      sourceKind: "mail_server",
      projectId: null,
      retainCount: 3,
    });
    const outcome = await prunePolicy(policy);
    expect(outcome).toEqual({
      dropped: 0,
      skipped: "mail-server policy — retention not implemented",
    });
  });

  it("says so when the destination row is gone", async () => {
    // The artifacts outlive the destination row, so they are now unreachable
    // AND unprunable — a broken state, not a no-op.
    const policy = await seedBackupPolicy(destinationId, { projectId, retainCount: 1 });
    await seedRuns(policy.id, 3);
    await repos.backupDestination.update(destinationId, { deletedAt: new Date() });

    const outcome = await prunePolicy(policy);
    expect(outcome.dropped).toBe(0);
    expect(outcome.skipped).toContain(destinationId);
    expect(h.deleted).toEqual([]);
  });

  it("honors a retention lock on a run that would otherwise be dropped", async () => {
    const policy = await seedBackupPolicy(destinationId, { projectId, retainCount: 1 });
    const runs = await seedRuns(policy.id, 3);
    await repos.backupRun.setRetentionLock(runs[0]!.id, new Date(Date.UTC(2099, 0, 1)));

    const outcome = await prunePolicy(policy);

    // The locked run is not a candidate at all, so it doesn't consume a keep
    // slot either: only the middle run is dropped.
    expect(outcome.dropped).toBe(1);
    expect(h.deleted).toEqual(["artifact-1.tar"]);
  });

  it("keeps N runs PER SERVICE, not N across the project", async () => {
    // A project-default policy fans out to every service (N runs per tick), so
    // a project-wide count would evict every service but one on first sweep.
    const policy = await seedBackupPolicy(destinationId, { projectId, retainCount: 1 });
    const api = await seedService(projectId, { name: "api" });
    const web = await seedService(projectId, { name: "web" });
    await seedRuns(policy.id, 2, { serviceId: api.id });
    await seedBackupRun(organizationId, {
      policyId: policy.id,
      projectId,
      serviceId: web.id,
      destinationId,
      status: "succeeded",
      finishedAt: new Date(Date.UTC(2026, 0, 9)),
      artifacts: [{ key: "web-only.tar" }],
    });

    const outcome = await prunePolicy(policy);

    expect(outcome.dropped).toBe(1);
    expect(h.deleted).toEqual(["artifact-0.tar"]);
  });

  it("ignores another policy's runs at the same destination", async () => {
    const mine = await seedBackupPolicy(destinationId, { projectId, retainCount: 1 });
    const svc = await seedService(projectId, { name: "api" });
    const theirs = await seedBackupPolicy(destinationId, {
      projectId,
      serviceId: svc.id,
      retainCount: 1,
    });
    await seedRuns(mine.id, 2);
    await seedRuns(theirs.id, 2, { serviceId: svc.id });

    const outcome = await prunePolicy(mine);

    expect(outcome.dropped).toBe(1);
    // Two policies sharing a destination must not co-mingle their windows.
    expect(h.deleted).toEqual(["artifact-0.tar"]);
  });
});
