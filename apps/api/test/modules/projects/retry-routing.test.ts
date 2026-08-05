import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn(), updateStatus: vi.fn() }));
const domainRepo = vi.hoisted(() => ({ listByProject: vi.fn(), update: vi.fn() }));

const edgeProxy = vi.hoisted(() => vi.fn());
const siteFor = vi.hoisted(() => vi.fn());
const withExecutor = vi.hoisted(() => vi.fn());
const convergeAllProjectRoutes = vi.hoisted(() => vi.fn());
const syncManagedEdgeRoutes = vi.hoisted(() => vi.fn());

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      deployment: deploymentRepo,
      domain: domainRepo,
    },
  };
});

vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  return { ...actual, edgeProxy };
});

vi.mock("../../../src/lib/ssh-manager", () => ({ sshManager: { withExecutor } }));

vi.mock("../../../src/lib/managed-edge-proxy", () => ({
  syncManagedEdgeRoutes,
  edgeUnsyncedWarning: () => "routing unsynced",
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: vi.fn(),
}));

vi.mock("../../../src/modules/domains/project-route.service", () => ({
  convergeAllProjectRoutes,
}));

import { retryProjectRouting } from "../../../src/modules/projects/project-runtime.service";

// A clearly-custom hostname (never under any routing base domain) so
// syncProjectManagedEdge finds zero managed targets and just clears the warning.
const CUSTOM_HOST = "api.acme.test";

function nulledCustomRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dom_api",
    projectId: "proj_1",
    serviceId: null,
    hostname: CUSTOM_HOST,
    domainType: "custom",
    verified: true,
    targetPort: null,
    targetPath: null,
    ...overrides,
  } as any;
}

function liveSite() {
  return {
    serverNames: [CUSTOM_HOST],
    ssl: true,
    target: { kind: "proxy", url: "http://127.0.0.1:4000" },
    routes: [{ path: "/", url: "http://127.0.0.1:4000" }],
  } as any;
}

describe("retryProjectRouting — safe self-heal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectRepo.findById.mockResolvedValue({
      id: "proj_1",
      organizationId: "org_1",
      cloudWorkspaceId: null,
      serverId: "srv_1",
      activeDeploymentId: "dep_1",
    });
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      status: "ready",
      meta: { serverId: "srv_1", deployTarget: "server" },
    });
    deploymentRepo.updateStatus.mockResolvedValue(undefined);
    domainRepo.listByProject.mockResolvedValue([]);
    domainRepo.update.mockResolvedValue(undefined);
    convergeAllProjectRoutes.mockResolvedValue(undefined);
    syncManagedEdgeRoutes.mockResolvedValue({ failures: [] });
    // withExecutor(serverId, fn) → run fn with a dummy executor.
    withExecutor.mockImplementation(
      async (_serverId: string, fn: (e: unknown) => Promise<unknown>) => fn({}),
    );
    edgeProxy.mockResolvedValue({ siteFor });
  });

  it("restores a nulled verified custom port from what the edge actually serves", async () => {
    domainRepo.listByProject.mockResolvedValue([nulledCustomRow()]);
    siteFor.mockResolvedValue(liveSite());

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({ ok: true });
    expect(domainRepo.update).toHaveBeenCalledWith("dom_api", { targetPort: 4000 });
    expect(convergeAllProjectRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj_1" }),
    );
  });

  it("keeps Action Required when strict route convergence fails", async () => {
    convergeAllProjectRoutes.mockRejectedValue(new Error("vhost write failed"));

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({
      ok: false,
      warning:
        "Couldn't re-apply the project's routes at the edge — retry once the server is reachable.",
    });
    expect(deploymentRepo.updateStatus).toHaveBeenLastCalledWith("dep_1", "ready", {
      meta: expect.objectContaining({
        edgeUnsynced: true,
        deployWarning:
          "Couldn't re-apply the project's routes at the edge — retry once the server is reachable.",
      }),
    });
  });

  it("leaves the row unchanged when the edge has no live upstream (never guesses)", async () => {
    domainRepo.listByProject.mockResolvedValue([nulledCustomRow()]);
    siteFor.mockResolvedValue(null);

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({ ok: true });
    expect(domainRepo.update).not.toHaveBeenCalled();
  });

  // The guardrail: a project with genuinely no domain and no server binding must
  // heal cleanly without reaching for the edge or fabricating anything — it stays
  // "Local" rather than being forced onto a server.
  it("does not touch the edge for a domain-less, server-less project", async () => {
    projectRepo.findById.mockResolvedValue({
      id: "proj_1",
      organizationId: "org_1",
      cloudWorkspaceId: null,
      serverId: null,
      activeDeploymentId: "dep_1",
    });
    deploymentRepo.findById.mockResolvedValue({ id: "dep_1", status: "ready", meta: {} });
    domainRepo.listByProject.mockResolvedValue([]);

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({ ok: true });
    expect(withExecutor).not.toHaveBeenCalled();
    expect(domainRepo.update).not.toHaveBeenCalled();
  });

  // Fix 2c step 1: a snapshot whose meta.serverId drifted from the durable binding
  // is re-stamped so routing resolves to the server again, not "local".
  it("re-stamps a drifted deployment meta from the durable project.serverId", async () => {
    deploymentRepo.findById.mockResolvedValue({ id: "dep_1", status: "ready", meta: {} });

    await retryProjectRouting("proj_1", "org_1");

    expect(deploymentRepo.updateStatus).toHaveBeenCalledWith("dep_1", "ready", {
      meta: expect.objectContaining({ serverId: "srv_1", deployTarget: "server" }),
    });
  });

  it("is a no-op for a cloud project (no server edge to repair)", async () => {
    projectRepo.findById.mockResolvedValue({
      id: "proj_1",
      organizationId: "org_1",
      cloudWorkspaceId: "ws_1",
      serverId: null,
      activeDeploymentId: "dep_1",
    });

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({ ok: true });
    expect(convergeAllProjectRoutes).not.toHaveBeenCalled();
    expect(withExecutor).not.toHaveBeenCalled();
  });
});
