import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `emitServiceCheckRun` — the only thing that reports a deploy back to GitHub.
 *
 * It was silently reporting almost nothing. The completion path created a check
 * run only when `conclusion === "neutral"`, and a neutral conclusion is reached
 * exclusively by services a scoped deploy SKIPPED. Every service that actually
 * built took the `sd.checkRunId` branch — with no checkRunId, because the
 * `phase: "start"` emit that would have set one could never run (a targeted
 * service has no `service_deployment` row until the compose loop records its
 * outcome, so `entry.id` was always null in emitInitialServiceChecks). Net: a
 * scoped deploy posted only "skipped" checks, and a FULL deploy — which
 * pre-creates no rows at all — posted nothing whatsoever.
 *
 * So the properties pinned here are: every conclusion creates exactly one check
 * run, a completed run always carries a conclusion (GitHub 422s otherwise), an
 * existing run is patched rather than duplicated, and the skip copy only lands
 * on an actual skip.
 */

const h = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<Record<string, unknown>>,
  /** The persisted row emitServiceCheckRun re-reads before deciding. */
  row: null as { checkRunId: number | null } | null,
  rowUpdates: [] as Array<Record<string, unknown>>,
  orgOwner: { userId: "owner_1" } as { userId: string } | null,
}));

vi.mock("@repo/db", () => ({
  repos: {
    serviceDeployment: {
      findById: async () => h.row,
      update: async (_id: string, patch: Record<string, unknown>) => {
        h.rowUpdates.push(patch);
      },
    },
  },
}));

vi.mock("../github/github.service", () => ({
  createCheckRun: async (_ctx: unknown, owner: string, repo: string, opts: Record<string, unknown>) => {
    h.createCalls.push({ owner, repo, ...opts });
    return { id: 555, htmlUrl: "https://github.com/acme/app/runs/555" };
  },
  updateCheckRun: async (_ctx: unknown, owner: string, repo: string, id: number, opts: Record<string, unknown>) => {
    h.updateCalls.push({ owner, repo, id, ...opts });
  },
}));

vi.mock("../../lib/org-actor", () => ({ resolveOrgOwner: async () => h.orgOwner }));
vi.mock("../../lib/request-context", () => ({
  buildBackgroundContext: (o: unknown) => o,
}));
vi.mock("../../config", () => ({ runtimeTarget: { dashboard: "https://openship.test/" } }));
vi.mock("@repo/core", () => ({
  isServiceSuccessStatus: (s: string) => s === "success" || s === "running",
  isServiceFailureStatus: (s: string) => s === "failure" || s === "cancelled",
}));

const load = () => import("./service-checks");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const project = { gitOwner: "acme", gitRepo: "app" } as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dep = { id: "dep_1", organizationId: "org_1", commitSha: "a1b2c3d4e5" } as any;

describe("emitServiceCheckRun", () => {
  beforeEach(() => {
    h.createCalls = [];
    h.updateCalls = [];
    h.rowUpdates = [];
    h.row = { checkRunId: null };
    h.orgOwner = { userId: "owner_1" };
  });

  it("creates a completed check for a service that actually built — the regression", async () => {
    const { emitServiceCheckRun } = await load();

    await emitServiceCheckRun({
      project,
      dep,
      serviceDeploymentId: "sd_1",
      serviceName: "web",
      conclusion: "success",
      output: { title: "web success", summary: "" },
    });

    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]).toMatchObject({
      owner: "acme",
      repo: "app",
      name: "build:web",
      headSha: "a1b2c3d4e5",
      status: "completed",
      conclusion: "success",
    });
    // The check id is persisted so a later patch hits the same run.
    expect(h.rowUpdates[0]).toMatchObject({ checkRunId: 555 });
  });

  it("creates a failure check too — not just neutral ones", async () => {
    const { emitServiceCheckRun } = await load();

    await emitServiceCheckRun({
      project,
      dep,
      serviceDeploymentId: "sd_1",
      serviceName: "api",
      conclusion: "failure",
      output: { title: "api failure", summary: "boom" },
    });

    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]).toMatchObject({ conclusion: "failure" });
  });

  it("always sends a conclusion on a completed run — GitHub 422s without one", async () => {
    const { emitServiceCheckRun } = await load();

    await emitServiceCheckRun({
      project,
      dep,
      serviceDeploymentId: "sd_1",
      serviceName: "web",
      // conclusion omitted
    });

    expect(h.createCalls[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
  });

  it("does not label a failure as 'Skipped' when no output was supplied", async () => {
    const { emitServiceCheckRun } = await load();

    await emitServiceCheckRun({
      project,
      dep,
      serviceDeploymentId: "sd_1",
      serviceName: "api",
      conclusion: "failure",
    });

    expect((h.createCalls[0].output as { title: string }).title).toBe("api failure");
  });

  it("keeps the skip copy for an actual skip", async () => {
    const { emitServiceCheckRun } = await load();

    await emitServiceCheckRun({
      project,
      dep,
      serviceDeploymentId: "sd_1",
      serviceName: "worker",
      conclusion: "neutral",
    });

    expect((h.createCalls[0].output as { title: string }).title).toBe("Skipped — no changes");
  });

  it("patches an existing check run instead of creating a second one", async () => {
    h.row = { checkRunId: 999 };
    const { emitServiceCheckRun } = await load();

    await emitServiceCheckRun({
      project,
      dep,
      serviceDeploymentId: "sd_1",
      serviceName: "web",
      conclusion: "success",
    });

    expect(h.createCalls).toHaveLength(0);
    expect(h.updateCalls).toHaveLength(1);
    expect(h.updateCalls[0]).toMatchObject({ id: 999, status: "completed", conclusion: "success" });
  });

  it("posts nothing without a commit sha — head_sha would be invalid", async () => {
    const { emitServiceCheckRun } = await load();

    await emitServiceCheckRun({
      project,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dep: { ...dep, commitSha: null } as any,
      serviceDeploymentId: "sd_1",
      serviceName: "web",
      conclusion: "success",
    });

    expect(h.createCalls).toHaveLength(0);
    expect(h.updateCalls).toHaveLength(0);
  });

  it("posts nothing for a project with no linked repo", async () => {
    const { emitServiceCheckRun } = await load();

    await emitServiceCheckRun({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      project: { gitOwner: null, gitRepo: null } as any,
      dep,
      serviceDeploymentId: "sd_1",
      serviceName: "web",
      conclusion: "success",
    });

    expect(h.createCalls).toHaveLength(0);
  });
});

describe("emitInitialServiceChecks", () => {
  beforeEach(() => {
    h.createCalls = [];
    h.updateCalls = [];
    h.rowUpdates = [];
    h.row = { checkRunId: null };
  });

  it("emits for skipped services only — a targeted entry has no row to hang a check on", async () => {
    const { emitInitialServiceChecks } = await load();

    const fanOut = new Map([
      // Targeted: id stays null until the compose loop records the outcome.
      ["svc_a", { id: null, serviceId: "svc_a", serviceName: "web", targeted: true }],
      // Skipped: pre-created, so it can be reported up front.
      ["svc_b", { id: "sd_b", serviceId: "svc_b", serviceName: "worker", targeted: false }],
    ]);

    await emitInitialServiceChecks(fanOut, project, dep);

    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]).toMatchObject({ name: "build:worker", conclusion: "neutral" });
  });
});
