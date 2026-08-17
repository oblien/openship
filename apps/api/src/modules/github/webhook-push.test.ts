import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPushPayload } from "./github.types";

const {
  findByGitRepo,
  consumeForceDeployNext,
  listByProject,
  webhookRecord,
  setChangedPaths,
  triggerDeployment,
  triggerMountedRelease,
  resolveOrgOwner,
} = vi.hoisted(() => ({
  findByGitRepo: vi.fn(),
  consumeForceDeployNext: vi.fn(),
  listByProject: vi.fn(),
  webhookRecord: vi.fn(),
  setChangedPaths: vi.fn(),
  triggerDeployment: vi.fn(),
  triggerMountedRelease: vi.fn(),
  resolveOrgOwner: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      project: { findByGitRepo, consumeForceDeployNext },
      service: { listByProject },
      webhookDelivery: { record: webhookRecord },
      deployment: { setChangedPaths },
    },
  };
});

vi.mock("../deployments/build.service", () => ({
  triggerDeployment,
}));

vi.mock("../deployments/mounted-release.service", () => ({
  triggerMountedRelease,
}));

vi.mock("../../lib/org-actor", () => ({
  resolveOrgOwner,
}));

vi.mock("../../lib/notification-dispatcher", () => ({
  notification: { emit: vi.fn() },
}));

import { handlePush } from "./webhook-push";

const PREFIXED_SERVICES = [
  { id: "svc_staff", name: "staff", rootDirectory: "apps/staff", enabled: true, kind: "compose" },
  { id: "svc_public", name: "public", rootDirectory: "apps/public", enabled: true, kind: "compose" },
  { id: "svc_mail", name: "mail", rootDirectory: "apps/mail", enabled: true, kind: "compose" },
];

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj-1",
    name: "ae",
    organizationId: "org-1",
    autoDeploy: true,
    gitBranch: "main",
    framework: "docker-compose",
    monorepoSharedPaths: null,
    installationId: null,
    mountedRelease: { enabled: true, containerPath: "/srv/app" },
    ...overrides,
  };
}

function pushPayload(files: string[], sha = "abc123def456"): GitHubPushPayload {
  const commit = {
    id: sha,
    message: `Commit ${sha}`,
    timestamp: new Date().toISOString(),
    url: `https://github.com/acme/site/commit/${sha}`,
    author: { name: "Jane", email: "jane@example.com" },
    committer: { name: "Jane", email: "jane@example.com" },
    added: [] as string[],
    removed: [] as string[],
    modified: files,
  };
  return {
    ref: "refs/heads/main",
    before: "0000000",
    after: sha,
    commits: [commit],
    head_commit: commit,
    repository: {
      name: "site",
      full_name: "acme/site",
      default_branch: "main",
      owner: { login: "acme", id: 1 },
    },
    sender: { id: 1, login: "jane" },
  };
}

describe("handlePush release planner dispatch", () => {
  beforeEach(() => {
    findByGitRepo.mockReset();
    consumeForceDeployNext.mockReset();
    listByProject.mockReset();
    webhookRecord.mockReset();
    setChangedPaths.mockReset();
    triggerDeployment.mockReset();
    triggerMountedRelease.mockReset();
    resolveOrgOwner.mockReset();

    findByGitRepo.mockResolvedValue([project()]);
    consumeForceDeployNext.mockResolvedValue(false);
    listByProject.mockResolvedValue(PREFIXED_SERVICES);
    webhookRecord.mockResolvedValue(undefined);
    setChangedPaths.mockResolvedValue(undefined);
    resolveOrgOwner.mockResolvedValue({ userId: "owner-1" });
    triggerMountedRelease.mockResolvedValue({ id: "dep-mounted" });
    triggerDeployment.mockResolvedValue({ deployment: { id: "dep-runtime" } });
  });

  it("mounted + Blade path calls triggerMountedRelease with trigger webhook", async () => {
    const result = await handlePush(
      pushPayload(["apps/staff/resources/views/home.blade.php"]),
    );

    expect(result.success).toBe(true);
    expect(triggerMountedRelease).toHaveBeenCalledTimes(1);
    expect(triggerMountedRelease).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner-1", organizationId: "org-1" }),
      "proj-1",
      expect.objectContaining({
        commitSha: "abc123def456",
        trigger: "webhook",
        plan: expect.objectContaining({ action: "deploy_code" }),
      }),
    );
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it("mounted + Dockerfile rebuilds via triggerDeployment", async () => {
    await handlePush(pushPayload(["apps/staff/Dockerfile"]));

    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    expect(triggerDeployment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        trigger: "webhook",
        plan: expect.objectContaining({ action: "rebuild_runtime" }),
      }),
    );
    expect(triggerDeployment.mock.calls[0]?.[1]?.refresh).toBeUndefined();
    expect(triggerMountedRelease).not.toHaveBeenCalled();
  });

  it("docs-only skip creates no deployment", async () => {
    const result = await handlePush(pushPayload(["docs/runbook.md", "README.md"]));

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/skipped/i);
    expect(triggerDeployment).not.toHaveBeenCalled();
    expect(triggerMountedRelease).not.toHaveBeenCalled();
  });

  it("Caddyfile-only push is a code deploy, not refresh: true", async () => {
    await handlePush(pushPayload(["apps/public/Caddyfile"]));

    expect(triggerMountedRelease).toHaveBeenCalledWith(
      expect.anything(),
      "proj-1",
      expect.objectContaining({
        trigger: "webhook",
        plan: expect.objectContaining({ action: "deploy_code" }),
      }),
    );
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it("first config-only push still creates a row", async () => {
    await handlePush(pushPayload(["apps/staff/.env.production"]));

    expect(triggerMountedRelease).toHaveBeenCalledTimes(1);
    expect(triggerDeployment).not.toHaveBeenCalled();
  });
});
