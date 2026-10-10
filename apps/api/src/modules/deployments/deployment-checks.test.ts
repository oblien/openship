import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment, DeploymentCheck, ServiceDeployment } from "@repo/db";
import { DEFAULT_GITHUB_DEPLOYMENT_CHECKS } from "@repo/core";

const h = vi.hoisted(() => ({
  enabled: true, dep: null as Deployment | null, project: {} as Record<string, unknown>, rows: [] as ServiceDeployment[],
  root: null as DeploymentCheck | null, mirrors: [] as DeploymentCheck[], workerActive: false,
  publish: vi.fn(), released: vi.fn(), claimed: false, renew: vi.fn(), owner: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: {
  deployment: { findById: async () => h.dep, hasLiveBuildExecution: async () => h.workerActive },
  project: { findByIdInOrganization: async (id: string, org: string) => h.project.organizationId === org ? h.project : undefined },
  serviceDeployment: { listByDeployment: async () => h.rows },
  deploymentCheck: {
    due: async () => [{ id: "root" }],
    claim: async () => { if (h.claimed) return undefined; h.claimed = true; return h.root; },
    renew: h.renew,
    list: async () => h.mirrors,
    ensureService: async (root: DeploymentCheck, serviceName: string) => {
      const row = { ...root, id: `check-${serviceName}`, source: null, serviceName, kind: "service", name: `${root.name} / ${serviceName}`, checkRunId: null, publishedDigest: null };
      h.mirrors.push(row); return row;
    },
    published: async (_root: string, _token: string, id: string, data: Partial<DeploymentCheck>) => {
      Object.assign(h.mirrors.find(row => row.id === id)!, data); return true;
    },
    release: async (_id: string, _token: string, result: unknown) => { h.released(result); h.claimed = false; },
  },
} }));
vi.mock("@repo/platform/engine/native/execution-policy", () => ({ nativeJobsEnabled: () => h.enabled }));
vi.mock("@repo/platform/engine/config/index", () => ({ runtimeTarget: { dashboard: "https://openship.test" } }));
vi.mock("@repo/platform/engine/lib/org-actor", () => ({ resolveOrgOwner: h.owner }));
vi.mock("@repo/platform/engine/modules/github/check-runs", async original => ({
  ...await original<typeof import("@repo/platform/engine/modules/github/check-runs")>(), syncGitHubCheck: h.publish,
}));
vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({}));

import { deploymentCheckOutcome, runDeploymentChecksSweep, serviceCheckOutcome } from "@repo/platform/engine/modules/deployments/deployment-checks";

beforeEach(() => {
  vi.resetAllMocks();
  h.enabled = true; h.claimed = false; h.workerActive = false;
  h.project = { id: "project", organizationId: "org", gitOwner: "acme", gitRepo: "app", gitProvider: "github", githubChecks: null };
  h.dep = { id: "dep", projectId: "project", organizationId: "org", commitSha: "a".repeat(40), status: "queued", createdAt: new Date(), updatedAt: new Date(), envVars: null } as Deployment;
  h.rows = [];
  h.root = {
    id: "root", deploymentId: "dep", kind: "rollup", name: "Openship / app / production", checkRunId: null,
    publishedDigest: null, attempts: 0, createdAt: new Date(),
    source: { owner: "acme", repo: "app", name: "Openship / app / production", checks: { ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS }, services: [{ name: "web", targeted: true }, { name: "db", targeted: false }] },
  } as DeploymentCheck;
  h.mirrors = [h.root];
  h.owner.mockResolvedValue({ userId: "owner" });
  h.renew.mockResolvedValue(true);
  h.publish.mockImplementation(async (_ctx, _owner, _repo, id, data, options) =>
    !id && options?.createIfMissing === false ? { id: null, error: null, skipped: true }
      : ({ id: id ?? String(h.publish.mock.calls.length + 100), error: null }));
});
const updates = () => h.publish.mock.calls.map(call => call[4]);

describe("durable deployment Checks on every execution target", () => {
  it.each(["local", "cloud"])("publishes queued, running and failed %s attempts without needing a service finalizer", async deployTarget => {
    h.project.deployTarget = deployTarget;
    await runDeploymentChecksSweep();
    expect(updates().map(update => update.status)).toEqual(["queued", "queued", "completed"]);
    expect(updates()[2].conclusion).toBe("neutral");
    h.dep!.status = "building";
    await runDeploymentChecksSweep();
    expect(updates().at(-1).status).toBe("in_progress");
    h.dep!.status = "failed"; h.dep!.errorMessage = "Clone failed before containers started";
    await runDeploymentChecksSweep();
    expect(updates().slice(-2).map(update => update.conclusion)).toEqual(["failure", "failure"]);
    expect(updates().at(-1).output.summary).toContain("Clone failed");
    expect(updates()[0].detailsUrl).toBe("https://openship.test/build/dep");
    expect(h.publish.mock.calls.at(-1)?.[0]).toMatchObject({ userId: "owner", organizationId: "org" });
    expect(h.released.mock.calls.at(-1)?.[0].nextAttemptAt).toBeNull();
    expect(h.mirrors).toHaveLength(3);
  });

  it.each(["failed", "cancelled", "no_changes", "action_required", "rejected"])("completes single-app %s checks", async status => {
    h.root!.source!.services = [];
    h.dep!.status = status;
    await runDeploymentChecksSweep();
    expect(updates()).toHaveLength(1);
    expect(updates()[0].status).toBe("completed");
    expect(h.released.mock.calls[0][0].nextAttemptAt).toBeNull();
  });

  it("waits for activation to settle and reports a partial failure honestly", async () => {
    h.dep!.status = "ready"; h.workerActive = true;
    h.rows = [{ id: "sd-web", serviceName: "web", status: "success" }] as ServiceDeployment[];
    await runDeploymentChecksSweep();
    expect(updates()[0].status).toBe("in_progress");
    h.workerActive = false; h.dep!.status = "partial_failure";
    h.rows[0].status = "failure"; h.rows[0].errorMessage = "Health check timed out";
    await runDeploymentChecksSweep();
    expect(updates().slice(-2).every(update => update.conclusion === "failure")).toBe(true);
    expect(h.mirrors.find(row => row.serviceName === "web")?.serviceDeploymentId).toBe("sd-web");
  });

  it("supports selected services and hides error details when requested", async () => {
    h.root!.source!.checks = { enabled: true, deployment: false, services: ["web"], includeErrors: false };
    h.dep!.status = "failed"; h.dep!.errorMessage = "Private diagnostic details";
    await runDeploymentChecksSweep();
    expect(updates()).toHaveLength(1);
    expect(updates()[0].name).toContain(" / web");
    expect(updates()[0].output.summary).not.toContain("Private diagnostic details");
  });

  it("includes service failure reasons in the overall Check when service Checks are off", async () => {
    h.root!.source!.checks.services = [];
    h.dep!.status = "partial_failure";
    h.rows = [
      { serviceName: "web", status: "failure", errorMessage: "Health check timed out" },
      { serviceName: "db", status: "success" },
    ] as ServiceDeployment[];
    await runDeploymentChecksSweep();
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({ conclusion: "failure", output: { summary: expect.stringContaining("web: Health check timed out") } });
    expect(updates()[0].output.summary).not.toContain("db:");
  });

  it("includes a service discovered after admission from this attempt's runtime records", async () => {
    await runDeploymentChecksSweep();
    h.publish.mockClear();
    h.dep!.status = "ready";
    h.rows = [
      { id: "sd-web", serviceName: "web", status: "success" },
      { id: "sd-new", serviceName: "new-worker", status: "success" },
    ] as ServiceDeployment[];
    await runDeploymentChecksSweep();
    expect(updates().find(update => update.name.endsWith(" / new-worker"))).toMatchObject({ conclusion: "success" });
    expect(h.mirrors.find(row => row.serviceName === "new-worker")?.serviceDeploymentId).toBe("sd-new");
  });

  it("redacts captured project and service secrets from error summaries", async () => {
    h.dep!.status = "failed";
    h.dep!.envVars = { INNOCENT_NAME: "private-value" };
    h.dep!.meta = { composeServices: [{ environment: { KEY: "service-password" } }] };
    h.dep!.errorMessage = "Unable to use private-value or service-password; https://u:password@host.test/path?token=other";
    await runDeploymentChecksSweep();
    const text = JSON.stringify(updates());
    expect(text).not.toContain("private-value");
    expect(text).not.toContain("service-password");
    expect(text).not.toContain("u:password");
    expect(text).not.toContain("token=other");
    expect(text).toContain("Unable to use");
  });

  it("retries GitHub failure without changing deployment status or creating extra local mirrors", async () => {
    h.dep!.status = "failed";
    h.publish.mockResolvedValueOnce({ id: null, error: "GitHub unavailable" });
    await runDeploymentChecksSweep();
    expect(h.dep!.status).toBe("failed");
    expect(h.released.mock.calls[0][0]).toMatchObject({ attempts: 1, lastError: "GitHub unavailable", nextAttemptAt: expect.any(Date) });
    await runDeploymentChecksSweep();
    expect(h.mirrors).toHaveLength(3);
    expect(h.released.mock.calls.at(-1)?.[0]).toMatchObject({ attempts: 0, lastError: null, nextAttemptAt: null });
  });

  it("does not send unchanged statuses to GitHub on each poll", async () => {
    await runDeploymentChecksSweep();
    h.publish.mockClear();
    await runDeploymentChecksSweep();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("closes existing checks when reporting is disabled during a deployment", async () => {
    await runDeploymentChecksSweep(); h.publish.mockClear();
    h.project.githubChecks = { ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, enabled: false };
    await runDeploymentChecksSweep();
    expect(updates().every(update => update.status === "completed" && update.conclusion === "neutral")).toBe(true);
    expect(h.released.mock.calls.at(-1)?.[0].nextAttemptAt).toBeNull();
  });

  it("does not create Checks after disabling a queued deployment", async () => {
    h.project.githubChecks = { ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, enabled: false };
    await runDeploymentChecksSweep();
    expect(h.publish.mock.calls.every(call => call[5].createIfMissing === false)).toBe(true);
    expect(h.mirrors.every(row => !row.checkRunId)).toBe(true);
  });

  it.each(["repository", "organization", "commit"])("does not report into a changed or missing %s", async kind => {
    h.dep!.status = "failed";
    if (kind === "repository") h.project.gitRepo = "another";
    if (kind === "organization") h.project.organizationId = "another";
    if (kind === "commit") h.dep!.commitSha = null;
    await runDeploymentChecksSweep();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.released.mock.calls[0][0].lastError).toBeTruthy();
  });

  it("stops outbound writes when the controller is quiesced or loses its lease", async () => {
    h.enabled = false;
    await runDeploymentChecksSweep();
    h.enabled = true; h.renew.mockResolvedValue(false);
    await runDeploymentChecksSweep();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("allows only one concurrent reporter to hold a deployment", async () => {
    await Promise.all([runDeploymentChecksSweep(), runDeploymentChecksSweep()]);
    expect(updates()).toHaveLength(3);
  });

  it("does not mark an unobserved service successful just because its parent is ready", () => {
    expect(serviceCheckOutcome(undefined, true, deploymentCheckOutcome({ status: "ready" }, false))).toMatchObject({ conclusion: "failure" });
  });

  it("keeps cancellation in progress until the worker acknowledges stopping", () => {
    expect(deploymentCheckOutcome({ status: "cancelled" }, true)).toMatchObject({ status: "in_progress", title: "Stopping deployment" });
    expect(deploymentCheckOutcome({ status: "cancelled" }, false)).toMatchObject({ status: "completed", conclusion: "cancelled" });
  });
});
