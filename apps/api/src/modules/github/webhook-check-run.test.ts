import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubCheckRunPayload } from "@repo/contracts";

const h = vi.hoisted(() => ({
  check: vi.fn(), list: vi.fn(), legacy: vi.fn(), serviceDeployment: vi.fn(),
  deployment: vi.fn(), project: vi.fn(), services: vi.fn(), owner: vi.fn(), trigger: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: {
  deploymentCheck: { findByCheckRunId: h.check, list: h.list },
  serviceDeployment: { findByCheckRunId: h.legacy, findById: h.serviceDeployment },
  deployment: { findById: h.deployment }, project: { findById: h.project },
  service: { listByProject: h.services },
} }));
vi.mock("@repo/platform/engine/lib/org-actor", () => ({ resolveOrgOwner: h.owner }));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({ triggerDeployment: h.trigger }));
import { handleCheckRun } from "./webhook-check-run";

const sha = "a".repeat(40);
const source = { owner: "acme", repo: "app" };
const project = { id: "project", organizationId: "org", gitProvider: "github", gitOwner: "acme", gitRepo: "app", gitBranch: "main" };
const check = { deploymentId: "dep", kind: "rollup", source };
const payload = () => ({ action: "rerequested", check_run: { id: 123, head_sha: sha }, repository: { owner: { login: "acme" }, name: "app" } }) as GitHubCheckRunPayload;

beforeEach(() => {
  vi.resetAllMocks();
  h.check.mockResolvedValue(check);
  h.list.mockResolvedValue([check]);
  h.deployment.mockResolvedValue({ id: "dep", projectId: "project", organizationId: "org", commitSha: sha, branch: "release", commitShaBefore: "b".repeat(40) });
  h.project.mockResolvedValue(project);
  h.owner.mockResolvedValue({ userId: "owner" });
  h.services.mockResolvedValue([{ id: "svc-web", name: "web", enabled: true }]);
  h.trigger.mockResolvedValue({ deploymentId: "new-dep" });
});

describe("GitHub deployment Check reruns", () => {
  it("reruns the overall deployment at its recorded commit and rollback anchor", async () => {
    expect((await handleCheckRun(payload())).success).toBe(true);
    expect(h.trigger).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", organizationId: "org" }), expect.objectContaining({
      projectId: "project", commitSha: sha, branch: "release", commitShaBefore: "b".repeat(40), trigger: "check-run", forceAll: true,
    }));
    expect(h.trigger.mock.calls[0][1].serviceIds).toBeUndefined();
  });

  it.each([true, false])("reruns only the requested service, including preflight failures (runtime row: %s)", async runtimeRow => {
    h.check.mockResolvedValue({ ...check, kind: "service", source: null, serviceName: "web", serviceDeploymentId: runtimeRow ? "sd-web" : null });
    h.serviceDeployment.mockResolvedValue({ id: "sd-web", serviceId: "svc-web", deploymentId: "dep" });
    await handleCheckRun(payload());
    expect(h.trigger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ serviceIds: ["svc-web"], forceAll: false, commitSha: sha }));
  });

  it("keeps existing service Checks on the same admission path", async () => {
    h.check.mockResolvedValue(undefined);
    h.legacy.mockResolvedValue({ deploymentId: "dep", serviceId: "svc-web" });
    await handleCheckRun(payload());
    expect(h.trigger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ serviceIds: ["svc-web"], forceAll: false }));
  });

  it.each(["repository", "organization", "revision", "disabled", "provider", "deleting", "captured source", "deleted service"])("refuses a rerun with mismatched %s", async mismatch => {
    const event = payload();
    if (mismatch === "repository") event.repository.name = "other";
    if (mismatch === "organization") h.project.mockResolvedValue({ ...project, organizationId: "other" });
    if (mismatch === "revision") event.check_run.head_sha = "c".repeat(40);
    if (mismatch === "disabled") h.project.mockResolvedValue({ ...project, githubChecks: { enabled: false } });
    if (mismatch === "provider") h.project.mockResolvedValue({ ...project, gitProvider: "gitlab" });
    if (mismatch === "deleting") h.project.mockResolvedValue({ ...project, deletionInProgress: true });
    if (mismatch === "captured source") h.check.mockResolvedValue({ ...check, source: { ...source, repo: "old" } });
    if (mismatch === "deleted service") {
      h.check.mockResolvedValue({ ...check, kind: "service", serviceName: "removed" });
    }
    await handleCheckRun(event);
    expect(h.trigger).not.toHaveBeenCalled();
  });

  it("lets the dispatcher persist an admission failure instead of acknowledging a nonexistent rerun", async () => {
    h.trigger.mockRejectedValue(new Error("Build queue unavailable"));
    await expect(handleCheckRun(payload())).rejects.toThrow("Build queue unavailable");
  });

  it("ignores ordinary Check updates and unknown Checks", async () => {
    await handleCheckRun({ ...payload(), action: "completed" });
    h.check.mockResolvedValue(undefined);
    await handleCheckRun(payload());
    expect(h.trigger).not.toHaveBeenCalled();
  });
});
