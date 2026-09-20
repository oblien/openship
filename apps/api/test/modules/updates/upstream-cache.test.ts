import "../mail/_setup-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The read path's freshness policy — i.e. "when is the cache allowed to answer?"
 *
 * The bug these exist for: the feed used to enumerate `update_status` ROWS. A
 * project the scanner had never reached had no row, so it was indistinguishable
 * from a project with nothing to report, and the issues page said "nothing needs
 * attention" while that same project's page showed a new commit sitting on main.
 * A six-hourly cron was the only thing that could ever create the row.
 *
 * So the invariants are:
 *
 *   1. Enumerate PROJECTS. A missing row is a question to answer, not a "no".
 *   2. A cached upstream answers only while it is still fresh AND still describes
 *      the project's current source. Otherwise re-poll — being silent until the
 *      next sweep is the failure, not the safe option.
 *   3. Every poll is written back, wherever it started. The project page and the
 *      tracker must not be able to know different things.
 *   4. A poll that came back empty-handed backs off for MINUTES, not the full TTL:
 *      one rate-limited request must not blind the tracker for six hours.
 *   5. Don't spend a round-trip on a project that cannot be behind (nothing
 *      deployed), and never spend two on one question at the same moment.
 */

const projectRepo = vi.hoisted(() => ({ listByOrganization: vi.fn(), findById: vi.fn() }));
const updateStatusRepo = vi.hoisted(() => ({
  listByOrg: vi.fn(),
  upsert: vi.fn(),
  deleteByProject: vi.fn(),
}));
const deploymentRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  findInProgressByCommit: vi.fn(),
  findInProgressByReleaseVersion: vi.fn(),
}));
const serviceRepo = vi.hoisted(() => ({ listByProject: vi.fn(), listByDeployment: vi.fn() }));
const resolveUpstreamDrift = vi.hoisted(() => vi.fn());

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      updateStatus: updateStatusRepo,
      deployment: deploymentRepo,
      service: serviceRepo,
    },
  };
});

// Only the network half is faked — evaluateDrift, hasDeployedSide and
// upstreamMatchesSource stay real, because they are what's under test with it.
vi.mock("@repo/platform/engine/modules/projects/project-crud.service", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/platform/engine/modules/projects/project-crud.service")
    >();
  return { ...actual, resolveUpstreamDrift };
});

// Never reached here; stubbed so the module graph doesn't drag in the build pipeline.
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  redeployBuildSession: vi.fn(),
}));

import {
  getProjectDrift,
  listOrganizationUpdates,
  scanOrganizationUpdates,
} from "@repo/platform/engine/modules/updates/updates.service";
import {
  commitSourceKey,
  type UpstreamDrift,
} from "@repo/platform/engine/modules/projects/project-crud.service";
import type { RequestContext } from "../../../src/lib/request-context";
import type { Project, UpdateStatus } from "@repo/db";

const SHIPPED = "13140747f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6";
const NEWER = "b80dd90aabbccddeeff00112233445566778899a";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const ctx = { organizationId: "org_1", userId: "user_1" } as RequestContext;

const project = (over: Partial<Project> = {}) =>
  ({
    id: "proj_1",
    organizationId: "org_1",
    name: "openship",
    slug: "openship",
    isApp: false,
    gitProvider: "github",
    gitOwner: "oblien",
    gitRepo: "openship",
    gitBranch: "main",
    appTemplateId: null,
    releaseSource: null,
    activeDeploymentId: over.id ? `dep_${over.id}` : "dep_live",
    ...over,
  }) as Project;

const upstream = (p: Project, latestSha: string | null): UpstreamDrift => ({
  supported: true,
  mode: "commit",
  key: commitSourceKey(p),
  latestSha,
  latestMessage: "Bump to v0.6.1 + announce",
});

/** A cache row as `updates:scan` would have written it. */
const cachedRow = (over: { key: string; latestSha: string | null; ageMs: number }): UpdateStatus =>
  ({
    id: "ups_1",
    organizationId: "org_1",
    projectId: "proj_1",
    kind: "commit",
    detail: { key: over.key, latestSha: over.latestSha, latestMessage: "cached message" },
    checkedAt: new Date(Date.now() - over.ageMs),
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as UpdateStatus;

/** Let queued microtasks (and the bounded-concurrency workers) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(projects: Project[], rows: UpdateStatus[]) {
  projectRepo.listByOrganization.mockResolvedValue({ rows: projects });
  projectRepo.findById.mockResolvedValue(projects[0]);
  updateStatusRepo.listByOrg.mockResolvedValue(rows);
  const deployments = new Map(projects.filter((p) => p.activeDeploymentId).map((p) => [
    p.activeDeploymentId,
    { id: p.activeDeploymentId, projectId: p.id, organizationId: p.organizationId, commitSha: SHIPPED },
  ]));
  deploymentRepo.findById.mockImplementation(async (id: string) => deployments.get(id));
}

beforeEach(() => {
  for (const fn of Object.values({
    ...projectRepo,
    ...updateStatusRepo,
    ...deploymentRepo,
    ...serviceRepo,
  })) {
    fn.mockReset();
  }
  resolveUpstreamDrift.mockReset();
  updateStatusRepo.upsert.mockResolvedValue(undefined);
  updateStatusRepo.deleteByProject.mockResolvedValue(undefined);
  deploymentRepo.findById.mockResolvedValue({ id: "dep_live", projectId: "proj_1", organizationId: "org_1", commitSha: SHIPPED });
  deploymentRepo.findInProgressByCommit.mockResolvedValue(undefined);
  deploymentRepo.findInProgressByReleaseVersion.mockResolvedValue(undefined);
  serviceRepo.listByProject.mockResolvedValue([]);
  serviceRepo.listByDeployment.mockResolvedValue([]);
});

describe("a project with no cached row", () => {
  it("is polled and reported behind, not skipped as up to date", async () => {
    // The reported bug, at the read path: empty cache, real drift on the remote.
    const p = project();
    setup([p], []);
    resolveUpstreamDrift.mockResolvedValue(upstream(p, NEWER));

    const items = await listOrganizationUpdates(ctx, { behindOnly: true });

    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      projectId: "proj_1",
      kind: "commit",
      behind: true,
      currentLabel: SHIPPED.slice(0, 7),
      latestLabel: NEWER.slice(0, 7),
    });
  });

  it("writes what it polled back, so the next surface reads it for free", async () => {
    const p = project();
    setup([p], []);
    resolveUpstreamDrift.mockResolvedValue(upstream(p, NEWER));

    await listOrganizationUpdates(ctx);

    expect(updateStatusRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        kind: "commit",
        // Full sha: the read path compares it, and a display prefix can't be.
        detail: expect.objectContaining({ latestSha: NEWER, key: "oblien/openship#main" }),
      }),
    );
  });

  it("does not poll a project with nothing deployed to be behind", async () => {
    setup([project({ activeDeploymentId: null })], []);

    const items = await listOrganizationUpdates(ctx);

    expect(resolveUpstreamDrift).not.toHaveBeenCalled();
    expect(items).toEqual([]);
  });
});

describe("when the cached row is allowed to answer", () => {
  it("reuses a fresh row without touching the network", async () => {
    const p = project();
    setup([p], [cachedRow({ key: commitSourceKey(p), latestSha: NEWER, ageMs: 30 * MINUTE })]);

    const items = await listOrganizationUpdates(ctx);

    expect(resolveUpstreamDrift).not.toHaveBeenCalled();
    expect(items[0]).toMatchObject({ behind: true, latestLabel: NEWER.slice(0, 7) });
  });

  it("still compares it against the CURRENT deployment", async () => {
    // Same row, but the operator has since shipped that commit. No invalidation
    // ran, and none is needed — the deployed side was never in the cache.
    const p = project();
    setup([p], [cachedRow({ key: commitSourceKey(p), latestSha: NEWER, ageMs: 30 * MINUTE })]);
    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", projectId: "proj_1", organizationId: "org_1", commitSha: NEWER });

    const items = await listOrganizationUpdates(ctx, { behindOnly: true });

    expect(items).toEqual([]);
  });

  it("polls fresh upstream when cache row was cleared by deployment success", async () => {
    const p = project();
    // Cache was invalidated on deploy, so no cached row exists for this project:
    setup([p], []);
    resolveUpstreamDrift.mockResolvedValue(upstream(p, NEWER));
    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", projectId: "proj_1", organizationId: "org_1", commitSha: NEWER });

    const items = await listOrganizationUpdates(ctx, { behindOnly: true });

    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(1);
    expect(items).toEqual([]);
  });

  it("re-polls once the row has outlived the scan interval", async () => {
    const p = project();
    setup([p], [cachedRow({ key: commitSourceKey(p), latestSha: SHIPPED, ageMs: 7 * HOUR })]);
    resolveUpstreamDrift.mockResolvedValue(upstream(p, NEWER));

    const items = await listOrganizationUpdates(ctx);

    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(1);
    expect(items[0]).toMatchObject({ behind: true, latestLabel: NEWER.slice(0, 7) });
  });

  it("re-polls a repointed branch instead of going quiet until the next sweep", async () => {
    // Row was polled for main; the project now tracks a release branch. Nothing
    // told the cache — it just stops matching the question.
    const p = project({ gitBranch: "release/0.6" });
    setup([p], [cachedRow({ key: "oblien/openship#main", latestSha: NEWER, ageMs: MINUTE })]);
    resolveUpstreamDrift.mockResolvedValue(upstream(p, NEWER));

    const items = await listOrganizationUpdates(ctx);

    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(1);
    expect(items[0]).toMatchObject({ behind: true });
  });
});

describe("a poll that resolved nothing", () => {
  it("is retried after minutes, not after the full TTL", async () => {
    const p = project();
    setup([p], [cachedRow({ key: commitSourceKey(p), latestSha: null, ageMs: 20 * MINUTE })]);
    resolveUpstreamDrift.mockResolvedValue(upstream(p, NEWER));

    const items = await listOrganizationUpdates(ctx);

    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(1);
    expect(items[0]).toMatchObject({ behind: true });
  });

  it("is not retried on every single request in the meantime", async () => {
    const p = project();
    setup([p], [cachedRow({ key: commitSourceKey(p), latestSha: null, ageMs: 2 * MINUTE })]);

    const items = await listOrganizationUpdates(ctx);

    expect(resolveUpstreamDrift).not.toHaveBeenCalled();
    // Unknown upstream is never evidence of drift.
    expect(items[0]).toMatchObject({ behind: false, latestLabel: null });
  });
});

describe("concurrent askers", () => {
  it("share one poll per project", async () => {
    // The home card, the issues page and a project page can all land in the same
    // second. On a cold cache that used to be three identical GitHub calls.
    const p = project();
    setup([p], []);
    let release: (u: UpstreamDrift) => void = () => {};
    resolveUpstreamDrift.mockReturnValue(
      new Promise<UpstreamDrift>((r) => {
        release = r;
      }),
    );

    const first = listOrganizationUpdates(ctx);
    const second = listOrganizationUpdates(ctx);
    await flush();
    release(upstream(p, NEWER));
    const [a, b] = await Promise.all([first, second]);

    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(1);
    expect(a[0]).toMatchObject({ behind: true });
    expect(b[0]).toMatchObject({ behind: true });
  });
});

describe("getProjectDrift (the project page banner)", () => {
  it("always polls, and caches what it learned for the other surfaces", async () => {
    const p = project();
    setup([p], []);
    resolveUpstreamDrift.mockResolvedValue(upstream(p, NEWER));

    const status = await getProjectDrift(ctx, "proj_1");

    expect(status).toMatchObject({ supported: true, behind: true, latestSha: NEWER });
    expect(updateStatusRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it("reports nothing for a project that has never deployed", async () => {
    const p = project({ activeDeploymentId: null });
    setup([p], []);

    expect(await getProjectDrift(ctx, "proj_1")).toEqual({ supported: false });
    expect(resolveUpstreamDrift).not.toHaveBeenCalled();
  });
});

describe("stalled upstream polls (GH-880)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(12 * MINUTE);
    vi.useRealTimers();
  });

  it("bounds a shared poll, records unknown state, backs off, and recovers without a restart", async () => {
    const p = project({ id: "deadline-resolver" });
    setup([p], []);
    let release!: (value: UpstreamDrift) => void;
    resolveUpstreamDrift.mockReturnValueOnce(
      new Promise<UpstreamDrift>((r) => {
        release = r;
      }),
    );
    const first = listOrganizationUpdates(ctx);
    const second = getProjectDrift(ctx, p.id);
    const scan = scanOrganizationUpdates(ctx, ctx.organizationId);
    await vi.advanceTimersByTimeAsync(8_001);
    expect((await first)[0]).toMatchObject({ behind: false, latestLabel: null });
    expect(await second).toMatchObject({ supported: true, latestSha: null, behind: false });
    expect(await scan).toEqual({ scanned: 1, supported: 1 });
    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(1);
    expect(updateStatusRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: p.id,
        kind: "commit",
        detail: expect.objectContaining({ latestSha: null }),
      }),
    );
    await listOrganizationUpdates(ctx);
    await getProjectDrift(ctx, p.id);
    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    let next!: (value: UpstreamDrift) => void;
    resolveUpstreamDrift.mockReturnValueOnce(
      new Promise<UpstreamDrift>((r) => {
        next = r;
      }),
    );
    const recovered = getProjectDrift(ctx, p.id);
    await vi.advanceTimersByTimeAsync(0);
    // The original promise wakes during a NEW poll: it must neither write old
    // data nor remove the new poll's deduplication entry.
    release(upstream(p, SHIPPED));
    await vi.advanceTimersByTimeAsync(0);
    const shared = listOrganizationUpdates(ctx);
    await vi.advanceTimersByTimeAsync(0);
    next(upstream(p, NEWER));
    expect(await recovered).toMatchObject({ behind: true, latestSha: NEWER });
    expect((await shared)[0]).toMatchObject({ behind: true });
    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(2);
    expect(updateStatusRepo.upsert).toHaveBeenCalledTimes(2);
    expect(updateStatusRepo.upsert.mock.calls[1][0].detail.latestSha).toBe(NEWER);
  });

  it("returns the known version when persistence hangs and retains backoff without the database", async () => {
    const p = project({ id: "deadline-write" });
    setup([p], []);
    resolveUpstreamDrift.mockResolvedValue(upstream(p, NEWER));
    updateStatusRepo.upsert.mockReturnValueOnce(new Promise(() => {}));
    const pending = listOrganizationUpdates(ctx);
    await vi.advanceTimersByTimeAsync(2_501);
    expect((await pending)[0]).toMatchObject({ behind: true });
    expect(await getProjectDrift(ctx, p.id)).toMatchObject({ latestSha: NEWER });
    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(1);
    expect(updateStatusRepo.upsert).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await getProjectDrift(ctx, p.id);
    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(2);
    expect(updateStatusRepo.upsert).toHaveBeenCalledTimes(2);
  });

  it("bounds a failed poll AND failed write and keeps healthy project updates", async () => {
    const bad = project({ id: "deadline-both" }),
      good = project({ id: "deadline-healthy" });
    setup([bad, good], []);
    resolveUpstreamDrift.mockImplementation((_actor, p) =>
      p.id === bad.id ? new Promise(() => {}) : Promise.resolve(upstream(good, NEWER)),
    );
    updateStatusRepo.upsert.mockImplementation((row) =>
      row.projectId === bad.id ? new Promise(() => {}) : Promise.resolve(),
    );
    const pending = listOrganizationUpdates(ctx);
    await vi.advanceTimersByTimeAsync(10_501);
    expect(await pending).toMatchObject([
      { projectId: good.id, behind: true },
      { projectId: bad.id, behind: false },
    ]);
    await listOrganizationUpdates(ctx);
    expect(resolveUpstreamDrift.mock.calls.filter(([, p]) => p.id === bad.id)).toHaveLength(1);
  });

  it("uses one feed deadline across concurrency waves instead of multiplying the timeout", async () => {
    setup(
      Array.from({ length: 30 }, (_, n) => project({ id: `deadline-wave-${n}` })),
      [],
    );
    resolveUpstreamDrift.mockReturnValue(new Promise(() => {}));
    const pending = listOrganizationUpdates(ctx);
    await vi.advanceTimersByTimeAsync(12_001);
    expect(await pending).toHaveLength(6);
    expect(resolveUpstreamDrift.mock.calls.length).toBeLessThan(30);
  });

  it("persists an unanswered image poll as short-lived unknown state", async () => {
    const p = project({ id: "deadline-images", gitOwner: null, gitRepo: null });
    setup([p], []);
    serviceRepo.listByProject.mockResolvedValue([
      { id: "svc", image: "example/app:latest", enabled: true },
    ]);
    resolveUpstreamDrift.mockReturnValue(new Promise(() => {}));
    const pending = listOrganizationUpdates(ctx);
    await vi.advanceTimersByTimeAsync(8_001);
    expect((await pending)[0]).toMatchObject({ kind: "image", behind: false, latestLabel: null });
    const row = updateStatusRepo.upsert.mock.calls[0][0];
    expect(row).toMatchObject({ kind: "image", detail: { digestByRef: {} } });
    updateStatusRepo.listByOrg.mockResolvedValue([row]);
    await listOrganizationUpdates(ctx);
    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(1);
  });

  it("does not apply a failed branch's backoff to a newly selected branch", async () => {
    const p = project({ id: "deadline-repointed" });
    setup([p], []);
    resolveUpstreamDrift.mockRejectedValueOnce(new Error("provider offline"));
    await getProjectDrift(ctx, p.id);
    const changed = { ...p, gitBranch: "release" };
    setup([changed], []);
    resolveUpstreamDrift.mockResolvedValue(upstream(changed, NEWER));
    expect(await getProjectDrift(ctx, p.id)).toMatchObject({ behind: true, branch: "release" });
    expect(resolveUpstreamDrift).toHaveBeenCalledTimes(2);
  });
});
