import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({ listByProject: vi.fn() }));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn(), updateStatus: vi.fn() }));
const domainRepo = vi.hoisted(() => ({ listByProject: vi.fn(), update: vi.fn() }));

const edgeProxy = vi.hoisted(() => vi.fn());
const checkEdge = vi.hoisted(() => vi.fn());
const siteFor = vi.hoisted(() => vi.fn());
const withExecutor = vi.hoisted(() => vi.fn());
const applyProjectRouting = vi.hoisted(() => vi.fn());
const reapplyProjectLiveRoutes = vi.hoisted(() => vi.fn());
const syncManagedEdgeRoutes = vi.hoisted(() => vi.fn());
const withDeploymentPlatform = vi.hoisted(() => vi.fn());
const reconcileServerEdge = vi.hoisted(() => vi.fn());

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      service: serviceRepo,
      deployment: deploymentRepo,
      domain: domainRepo,
    },
  };
});

vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  return { ...actual, edgeProxy, checkEdge };
});

// Activity ownership and cross-controller exclusion have their own integration
// suite. These cases exercise the routing writer and warning transitions.
vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({
  withCloudWorkspaceActivity: async (_id: unknown, work: () => Promise<unknown>) => work(),
}));

vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: { withExecutor } }));

vi.mock("@repo/platform/engine/lib/managed-edge-proxy", () => ({
  syncManagedEdgeRoutes,
  edgeUnsyncedWarning: () => "routing unsynced",
}));

vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>(),
  resolveDeploymentRuntime: vi.fn(),
  withDeploymentPlatform,
}));

vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "selfhosted" }),
}));

vi.mock("@repo/platform/engine/lib/edge-reconcile", () => ({ reconcileServerEdge }));

vi.mock("@repo/platform/engine/modules/domains/routing-apply.service", () => ({
  applyProjectRouting,
}));

vi.mock("@repo/platform/engine/modules/domains/project-route.service", () => ({
  reapplyProjectLiveRoutes,
}));

import { retryProjectRouting, syncProjectManagedEdge } from "@repo/platform/engine/modules/projects/project-runtime.service";

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
      workspaceId: null,
      serverId: "srv_1",
      activeDeploymentId: "dep_1",
    });
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      projectId: "proj_1", organizationId: "org_1",
      status: "ready",
      meta: { serverId: "srv_1", deployTarget: "server" },
    });
    deploymentRepo.updateStatus.mockResolvedValue(undefined);
    domainRepo.listByProject.mockResolvedValue([]);
    serviceRepo.listByProject.mockResolvedValue([]);
    domainRepo.update.mockResolvedValue(undefined);
    applyProjectRouting.mockResolvedValue(undefined);
    reapplyProjectLiveRoutes.mockResolvedValue(undefined);
    syncManagedEdgeRoutes.mockResolvedValue({ failures: [] });
    reconcileServerEdge.mockResolvedValue({ converted: false, updated: false, edgeDown: false });
    withDeploymentPlatform.mockImplementation(
      async (_dep: unknown, fn: (resolved: { executor: unknown; effectiveTarget: string }) => Promise<unknown>) =>
        fn({ executor: {}, effectiveTarget: "server" }),
    );
    // withExecutor(serverId, fn) → run fn with a dummy executor.
    withExecutor.mockImplementation(async (_serverId: string, fn: (e: unknown) => Promise<unknown>) =>
      fn({}),
    );
    edgeProxy.mockResolvedValue({ siteFor });
    checkEdge.mockResolvedValue({ name: "edge", healthy: true, message: "edge 1.27.1.1 - running" });
  });

  // Regression: retry used to call ONLY applyProjectRouting, which is composite-only
  // (1 static + 1 server) and emits nothing for a lone static app — so a static
  // project whose deploy-time edge write failed stayed 404 forever. Retry must go
  // through the static-aware reapplyProjectLiveRoutes, which serves `/` from a doc
  // root. `[]` previousHostnames (retry drops nothing) and managedEdgeSyncedByCaller
  // (syncProjectManagedEdge below owns the *.opsh.io sync — avoid a double challenge).
  it("re-applies the single-app + static route surface, not just the composite path", async () => {
    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({ ok: true });
    expect(reapplyProjectLiveRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj_1" }),
      [],
      { managedEdgeSyncedByCaller: true, onWarning: expect.any(Function) },
    );
  });

  it("does not report success or touch routing when the active deployment is missing", async () => {
    deploymentRepo.findById.mockResolvedValue(undefined);
    const verifyDomains = vi.fn();
    expect(await retryProjectRouting("proj_1", "org_1", { verifyDomains })).toEqual({
      ok: false,
      warning: expect.stringContaining("no active deployment"),
    });
    expect(verifyDomains).not.toHaveBeenCalled();
    expect(reapplyProjectLiveRoutes).not.toHaveBeenCalled();
    expect(applyProjectRouting).not.toHaveBeenCalled();
  });

  it("restores the edge even when service route settings have no domain rows yet", async () => {
    serviceRepo.listByProject.mockResolvedValue([{ id: "api", enabled: true, exposed: true }]);
    const onLog = vi.fn();
    const result = await retryProjectRouting("proj_1", "org_1", { onLog });
    expect(result).toEqual({ ok: true });
    expect(reconcileServerEdge).toHaveBeenCalledOnce();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("edge proxy"));
  });

  it("keeps the warning until domain and HTTPS checks finish, then preserves a partial failure", async () => {
    const existingWarning = { edgeUnsynced: true, deployWarning: "old routing failure" };
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      projectId: "proj_1",
      organizationId: "org_1",
      status: "ready",
      meta: { ...existingWarning, serverId: "srv_1", deployTarget: "server" },
    });
    const verifyDomains = vi.fn(async () => {
      expect(deploymentRepo.updateStatus).not.toHaveBeenCalled();
      return ["api.example.com: DNS verification is still pending"];
    });
    expect(await retryProjectRouting("proj_1", "org_1", { verifyDomains })).toEqual({
      ok: false,
      warning: "api.example.com: DNS verification is still pending",
    });
    expect(verifyDomains).toHaveBeenCalledOnce();
    expect(deploymentRepo.updateStatus).toHaveBeenCalledExactlyOnceWith("dep_1", "ready", {
      meta: expect.objectContaining({
        edgeUnsynced: true,
        deployWarning: "api.example.com: DNS verification is still pending",
      }),
    });
  });

  it("clears the warning only after successful domain checks", async () => {
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      projectId: "proj_1",
      organizationId: "org_1",
      status: "ready",
      meta: {
        edgeUnsynced: true,
        deployWarning: "pending",
        serverId: "srv_1",
        deployTarget: "server",
      },
    });
    const verifyDomains = vi.fn(async () => {
      expect(deploymentRepo.updateStatus).not.toHaveBeenCalled();
      return [];
    });
    expect(await retryProjectRouting("proj_1", "org_1", { verifyDomains })).toEqual({ ok: true });
    expect(deploymentRepo.updateStatus).toHaveBeenCalledExactlyOnceWith("dep_1", "ready", {
      meta: { serverId: "srv_1", deployTarget: "server" },
    });
  });

  it("keeps a skipped domain's diagnosis visible even when the edge itself is healthy (#879)", async () => {
    const warning = "Select a target port for app.example.com in Domains & Routes";
    reapplyProjectLiveRoutes.mockImplementationOnce(async (_project, _previous, options) => {
      options.onWarning(warning);
    });
    const result = await retryProjectRouting("proj_1", "org_1");
    expect(result).toEqual({ ok: false, warning });
    expect(deploymentRepo.updateStatus).toHaveBeenLastCalledWith(
      "dep_1",
      "ready",
      expect.objectContaining({
        meta: expect.objectContaining({ edgeUnsynced: true, deployWarning: warning }),
      }),
    );
  });

  it("restores a nulled verified custom port from what the edge actually serves", async () => {
    domainRepo.listByProject.mockResolvedValue([nulledCustomRow()]);
    siteFor.mockResolvedValue(liveSite());

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({ ok: true });
    expect(domainRepo.update).toHaveBeenCalledWith("dom_api", { targetPort: 4000 });
  });

  it("revives a stopped or missing edge before applying any route configuration (#693)", async () => {
    domainRepo.listByProject.mockResolvedValue([nulledCustomRow({ targetPort: 4000 })]);

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({ ok: true });
    expect(reconcileServerEdge).toHaveBeenCalledOnce();
    expect(checkEdge).toHaveBeenCalled();
    expect(reconcileServerEdge.mock.invocationCallOrder[0]).toBeLessThan(
      reapplyProjectLiveRoutes.mock.invocationCallOrder[0]!,
    );
    expect(reconcileServerEdge.mock.invocationCallOrder[0]).toBeLessThan(
      applyProjectRouting.mock.invocationCallOrder[0]!,
    );
  });

  it("fails fast with the recovery reason instead of issuing edge commands when revival fails (#693)", async () => {
    domainRepo.listByProject.mockResolvedValue([nulledCustomRow({ targetPort: 4000 })]);
    reconcileServerEdge.mockResolvedValue({
      converted: false,
      updated: false,
      edgeDown: true,
      error: "docker start openship-edge failed",
    });

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({
      ok: false,
      warning: "Couldn't restore the edge before retrying routing: docker start openship-edge failed",
    });
    expect(reapplyProjectLiveRoutes).not.toHaveBeenCalled();
    expect(applyProjectRouting).not.toHaveBeenCalled();
    expect(checkEdge).not.toHaveBeenCalled();
    expect(deploymentRepo.updateStatus).toHaveBeenCalledWith(
      "dep_1",
      "ready",
      { meta: expect.objectContaining({ edgeUnsynced: true }) },
    );
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
      workspaceId: null,
      serverId: null,
      activeDeploymentId: "dep_1",
    });
    deploymentRepo.findById.mockResolvedValue({ id: "dep_1", projectId: "proj_1", organizationId: "org_1", status: "ready", meta: {} });
    domainRepo.listByProject.mockResolvedValue([]);

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({ ok: true });
    expect(reconcileServerEdge).not.toHaveBeenCalled();
    expect(withExecutor).not.toHaveBeenCalled();
    expect(domainRepo.update).not.toHaveBeenCalled();
  });

  // Fix 2c step 1: a snapshot whose meta.serverId drifted from the durable binding
  // is re-stamped so routing resolves to the server again, not "local".
  it("re-stamps a drifted deployment meta from the durable project.serverId", async () => {
    deploymentRepo.findById.mockResolvedValue({ id: "dep_1", projectId: "proj_1", organizationId: "org_1", status: "ready", meta: {} });

    await retryProjectRouting("proj_1", "org_1");

    expect(deploymentRepo.updateStatus).toHaveBeenCalledWith(
      "dep_1",
      "ready",
      { meta: expect.objectContaining({ serverId: "srv_1", deployTarget: "server" }) },
    );
  });

  // ── "Live" must mean SERVED, not merely written ──
  //
  // Every step of this action writes configuration, and an edge crash-looping on
  // `bind() … Address already in use` accepts all of it: the vhost lands on the host
  // bind mount, the cloud-side slug sync succeeds, and nothing answers on :80. The
  // action used to return ok:true there, so pressing "Retry routing" on a box whose
  // edge had never bound reported the project Live while every one of its URLs was
  // dead — the one thing the operator pressed it to find out.
  it("reports the edge's own reason instead of success when the routes aren't served", async () => {
    domainRepo.listByProject.mockResolvedValue([nulledCustomRow()]);
    siteFor.mockResolvedValue(liveSite());
    checkEdge.mockResolvedValue({
      name: "edge",
      healthy: false,
      message:
        "The edge container openship-edge is not serving — nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)",
    });

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/Address already in use/);
    // …and the project keeps its Action Required state rather than flipping to Live.
    expect(deploymentRepo.updateStatus).toHaveBeenCalledWith(
      "dep_1",
      "ready",
      { meta: expect.objectContaining({ edgeUnsynced: true }) },
    );
  });

  it("does not ask about the edge for a project with no domains on it", async () => {
    domainRepo.listByProject.mockResolvedValue([]);
    checkEdge.mockResolvedValue({ name: "edge", healthy: false, message: "not serving" });

    // Nothing of this project's is at the edge, so the edge's state can't make its
    // routing unsynced — raising it here would be an issue the operator can't act on
    // from this button.
    expect(await retryProjectRouting("proj_1", "org_1")).toEqual({ ok: true });
    expect(checkEdge).not.toHaveBeenCalled();
  });

  it("treats an unreachable box as no signal, not as a dead edge", async () => {
    domainRepo.listByProject.mockResolvedValue([nulledCustomRow()]);
    siteFor.mockResolvedValue(liveSite());
    withExecutor.mockImplementation(async (_serverId: string, fn: (e: unknown) => Promise<unknown>) => {
      // The port-restore read happens first and tolerates a drop; the serving probe
      // is the second call and must not turn "couldn't ask" into "not serving".
      if (edgeProxy.mock.calls.length === 0) return fn({});
      throw new Error("ssh: connect: connection refused");
    });

    expect(await retryProjectRouting("proj_1", "org_1")).toEqual({ ok: true });
  });

  it("repairs managed Cloud routing without configuring a server edge", async () => {
    const workspaceId = "owner_1";
    projectRepo.findById.mockResolvedValue({
      id: "proj_1",
      organizationId: "org_1",
      workspaceId,
      serverId: "managed-server",
      activeDeploymentId: "dep_1",
    });
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1", projectId: "proj_1", organizationId: "org_1", status: "ready",
      containerId: "ws_1",
      meta: { deployTarget: "cloud", edgeUnsynced: true, deployWarning: "old server IP warning" },
    });
    domainRepo.listByProject.mockResolvedValue([nulledCustomRow({ hostname: "app.opsh.io", domainType: "free", targetPort: 8000 })]);

    const result = await retryProjectRouting("proj_1", "org_1");

    expect(result).toEqual({ ok: true });
    expect(reapplyProjectLiveRoutes).toHaveBeenCalledOnce();
    expect(applyProjectRouting).toHaveBeenCalledOnce();
    expect(syncManagedEdgeRoutes).not.toHaveBeenCalled();
    expect(reconcileServerEdge).not.toHaveBeenCalled();
    expect(withExecutor).not.toHaveBeenCalled();
    expect(deploymentRepo.updateStatus).toHaveBeenCalledWith("dep_1", "ready", { meta: { deployTarget: "cloud" } });
  });

  it("preserves a failed managed Cloud port update instead of clearing its warning", async () => {
    projectRepo.findById.mockResolvedValue({ id: "proj_1", organizationId: "org_1", workspaceId: null, activeDeploymentId: "dep_1" });
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1", projectId: "proj_1", organizationId: "org_1", status: "ready",
      meta: { deployTarget: "cloud" },
    });
    reapplyProjectLiveRoutes.mockRejectedValueOnce(new Error("Provider could not update port 8000"));
    const verifyDomains = vi.fn();

    expect(await retryProjectRouting("proj_1", "org_1", { verifyDomains })).toEqual({
      ok: false, warning: "Provider could not update port 8000",
    });
    expect(verifyDomains).not.toHaveBeenCalled();
    expect(syncManagedEdgeRoutes).not.toHaveBeenCalled();
    expect(deploymentRepo.updateStatus).toHaveBeenCalledWith("dep_1", "ready", {
      meta: { deployTarget: "cloud", edgeUnsynced: true, deployWarning: "Provider could not update port 8000" },
    });
  });

  it("skips external server-proxy synchronization for a Cloud deployment and preserves its current warning", async () => {
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1", projectId: "proj_1", organizationId: "org_1", status: "ready",
      meta: { deployTarget: "cloud", edgeUnsynced: true, deployWarning: "Cloud route update failed" },
    });
    domainRepo.listByProject.mockResolvedValue([nulledCustomRow({ hostname: "app.opsh.io", domainType: "free", targetPort: 8000 })]);

    expect(await syncProjectManagedEdge(await projectRepo.findById(), "org_1", { markOnFailure: true })).toEqual({ ok: true, failures: [] });
    expect(syncManagedEdgeRoutes).not.toHaveBeenCalled();
    expect(deploymentRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("repairs Cloud Docker routes and clears the warning only after a successful apply", async () => {
    projectRepo.findById.mockResolvedValue({ id: "proj_1", organizationId: "org_1", workspaceId: "owner_1", serverId: "managed-server", activeDeploymentId: "dep_1" });
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1", projectId: "proj_1", organizationId: "org_1", status: "ready",
      meta: { deployTarget: "cloud", managedServer: { projectId: "proj_1", workspaceId: "ws_1", ownerWorkspaceId: "owner_1" }, edgeUnsynced: true, deployWarning: "Previous route failure" },
    });

    expect(await retryProjectRouting("proj_1", "org_1")).toEqual({ ok: true });
    expect(applyProjectRouting).toHaveBeenCalledWith("proj_1", expect.objectContaining({ onWarning: expect.any(Function) }));
    expect(deploymentRepo.updateStatus).toHaveBeenCalledWith("dep_1", "ready", {
      meta: { deployTarget: "cloud", managedServer: { projectId: "proj_1", workspaceId: "ws_1", ownerWorkspaceId: "owner_1" } },
    });
    expect(withExecutor).not.toHaveBeenCalled();
  });

  it("keeps Cloud Docker routing failures visible for another retry", async () => {
    projectRepo.findById.mockResolvedValue({ id: "proj_1", organizationId: "org_1", workspaceId: "owner_1", serverId: "managed-server", activeDeploymentId: "dep_1" });
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1", projectId: "proj_1", organizationId: "org_1", status: "ready",
      meta: { deployTarget: "cloud", managedServer: { projectId: "proj_1", workspaceId: "ws_1", ownerWorkspaceId: "owner_1" } },
    });
    applyProjectRouting.mockImplementationOnce(async (_id, options) => options.onWarning("Cloud route could not be applied"));

    expect(await retryProjectRouting("proj_1", "org_1")).toEqual({ ok: false, warning: "Cloud route could not be applied" });
    expect(deploymentRepo.updateStatus).toHaveBeenCalledWith("dep_1", "ready", expect.objectContaining({
      meta: expect.objectContaining({ edgeUnsynced: true, deployWarning: "Cloud route could not be applied" }),
    }));
    expect(withExecutor).not.toHaveBeenCalled();
  });
});
