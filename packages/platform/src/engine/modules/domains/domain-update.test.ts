import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.INTERNAL_TOKEN ??= "test-fixture-internal-token-0000000000000";
});

const h = vi.hoisted(() => ({
  project: {
    id: "project-a",
    organizationId: "org-a",
    activeDeploymentId: "dep-a",
    workspaceId: null,
    deletionInProgress: false,
  } as any,
  domain: {
    id: "domain-a",
    ownerType: "project",
    projectId: "project-a",
    hostname: "app.example.com",
    status: "active",
    proxy: { clientMaxBodySize: "3m" },
  } as any,
  lock: vi.fn(),
  update: vi.fn(),
  find: vi.fn(),
  list: vi.fn(),
  edge: vi.fn(),
  reapply: vi.fn(),
  overlay: vi.fn(),
  supports: true as boolean | undefined,
  effectiveTarget: "local",
  withPlatform: vi.fn(),
  markWarning: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: async () => h.project },
    domain: { findById: h.find, update: h.update, listByProject: h.list },
  },
}));
vi.mock("../../lib/project-runtime-lock", () => ({ withLiveProjectRuntimeMutation: h.lock }));
vi.mock("../projects/project-deploy-target", () => ({
  resolveProjectLiveDeployTarget: async () => ({ deployTarget: "local" }),
}));
vi.mock("../projects/edge-config.service", () => ({ readProjectEdgeConfig: h.edge }));
vi.mock("../projects/project-runtime.service", () => ({ markRoutingWarning: h.markWarning }));
vi.mock("../../lib/deployment-runtime", () => ({ withDeploymentPlatform: h.withPlatform }));
vi.mock("../../lib/active-deployment", () => ({
  findActiveDeployment: async () => ({
    projectId: "project-a",
    organizationId: "org-a",
    meta: { deployTarget: "local" },
  }),
}));
vi.mock("./project-route.service", () => ({ reapplyProjectLiveRoutes: h.reapply }));
vi.mock("./routing-apply.service", () => ({ applyProjectRouting: h.overlay }));
vi.mock("../../lib/self-app-routing", () => ({ canRouteSelfApp: async () => false }));
// This suite exercises DB admission and orchestration only, with no host clients.
vi.mock("../../lib/platform-config", () => ({
  platform: () => ({ target: h.effectiveTarget, routing: { supportsDomainProxy: h.supports } }),
}));
vi.mock("../../lib/domain-ssl", () => ({}));
vi.mock("../../lib/dns-resolver", () => ({}));
vi.mock("../../lib/route-apply.service", () => ({ reconcileProjectRoutes: vi.fn() }));
vi.mock("../dns/dns-credential.service", () => ({}));
vi.mock("./domain-diagnostics", () => ({
  withDomainDiagnostics: async (_p: unknown, rows: unknown[]) => rows,
}));

import { updateDomain } from "./domain.service";
const ctx = { organizationId: "org-a", userId: "alice" } as any;
beforeEach(() => {
  vi.clearAllMocks();
  h.project = {
    id: "project-a",
    organizationId: "org-a",
    activeDeploymentId: "dep-a",
    workspaceId: null,
    deletionInProgress: false,
  };
  h.domain = {
    id: "domain-a",
    ownerType: "project",
    projectId: "project-a",
    hostname: "app.example.com",
    status: "active",
    proxy: { clientMaxBodySize: "3m" },
  };
  h.find.mockImplementation(async () => h.domain);
  h.list.mockImplementation(async () => [h.domain]);
  h.lock.mockImplementation(async (_id, work) =>
    h.project.deletionInProgress ? undefined : work(h.project),
  );
  h.update.mockImplementation(async (_id, patch) => (h.domain = { ...h.domain, ...patch }));
  h.supports = true;
  h.effectiveTarget = "local";
  h.withPlatform.mockImplementation(async (_dep, work) =>
    work({ routing: { supportsDomainProxy: h.supports }, effectiveTarget: h.effectiveTarget }),
  );
  h.edge.mockResolvedValue({ reachable: true, proxyKind: "openresty", hosts: [] });
  h.reapply.mockResolvedValue(undefined);
  h.overlay.mockResolvedValue(undefined);
});

describe("domain body cap mutation", () => {
  it("leaves an omitted field unchanged without touching the edge", async () => {
    expect((await updateDomain(ctx, "domain-a", {})).proxy).toEqual({ clientMaxBodySize: "3m" });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.edge).not.toHaveBeenCalled();
    expect(h.reapply).not.toHaveBeenCalled();
  });
  it.each([{ clientMaxBodySize: "0" }, { clientMaxBodySize: "2m" }, {}, null])(
    "replaces the saved object with %j and reapplies existing topology",
    async (proxy) => {
      expect((await updateDomain(ctx, "domain-a", { proxy })).proxy).toEqual(proxy);
      expect(h.update).toHaveBeenCalledWith("domain-a", { proxy });
      expect(h.reapply).toHaveBeenCalledWith(
        h.project,
        [h.domain.hostname],
        expect.objectContaining({ isSelfApp: false }),
      );
      expect(h.overlay).toHaveBeenCalledOnce();
      expect(h.lock).toHaveBeenCalledWith("project-a", expect.any(Function));
    },
  );
  it.each(["25", "1m\n", "1m;return 200", "99999999999999999999999999999999g", "1M", "-2m"])(
    "rejects invalid/injected/overflow value %j before saving",
    async (value) => {
      await expect(
        updateDomain(ctx, "domain-a", { proxy: { clientMaxBodySize: value } }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(h.update).not.toHaveBeenCalled();
    },
  );
  it("rejects unknown keys rather than silently dropping them", async () => {
    await expect(
      updateDomain(ctx, "domain-a", { proxy: { proxyReadTimeout: "1s" } } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      updateDomain(ctx, "domain-a", { projectId: "project-b" } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.update).not.toHaveBeenCalled();
  });
  it("hides foreign domains and rechecks ownership after waiting for the project lock", async () => {
    h.project.organizationId = "org-b";
    await expect(updateDomain(ctx, "domain-a", { proxy: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    h.project.organizationId = "org-a";
    h.find
      .mockResolvedValueOnce(h.domain)
      .mockResolvedValueOnce({ ...h.domain, projectId: "project-b" });
    await expect(updateDomain(ctx, "domain-a", { proxy: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.update).not.toHaveBeenCalled();
  });
  it("does not resurrect a deleted project or removing domain", async () => {
    h.project.deletionInProgress = true;
    await expect(updateDomain(ctx, "domain-a", { proxy: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    h.project.deletionInProgress = false;
    h.domain.status = "removing";
    await expect(updateDomain(ctx, "domain-a", { proxy: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.update).not.toHaveBeenCalled();
  });
  it("rechecks the owner type under lock after authorizing a project domain", async () => {
    h.find
      .mockResolvedValueOnce(h.domain)
      .mockResolvedValueOnce({ ...h.domain, ownerType: "webhook" });
    await expect(updateDomain(ctx, "domain-a", { proxy: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.edge).not.toHaveBeenCalled();
    expect(h.reapply).not.toHaveBeenCalled();
  });
  it("does not report a saved setting or apply routes when the row vanished", async () => {
    h.update.mockImplementation(async () => {
      h.domain = null;
    });
    await expect(updateDomain(ctx, "domain-a", { proxy: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.reapply).not.toHaveBeenCalled();
  });
  it.each(["traefik", "caddy"])(
    "rejects unsupported %s before persisting an override",
    async (kind) => {
      h.edge.mockResolvedValue({ reachable: true, proxyKind: kind });
      await expect(
        updateDomain(ctx, "domain-a", { proxy: { clientMaxBodySize: "2m" } }),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      expect(h.update).not.toHaveBeenCalled();
    },
  );
  it("rejects cloud and unconfirmed edges before saving a new override", async () => {
    h.project.workspaceId = "cloud-a";
    await expect(
      updateDomain(ctx, "domain-a", { proxy: { clientMaxBodySize: "2m" } }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    h.project.workspaceId = null;
    h.edge.mockResolvedValue({ reachable: false, hosts: [] });
    await expect(
      updateDomain(ctx, "domain-a", { proxy: { clientMaxBodySize: "2m" } }),
    ).rejects.toMatchObject({ code: "EDGE_UNAVAILABLE" });
    expect(h.update).not.toHaveBeenCalled();
  });
  it.each([false, undefined])(
    "rejects missing/false provider capability (%j) despite an unrelated installed nginx",
    async (supports) => {
      h.supports = supports;
      await expect(
        updateDomain(ctx, "domain-a", { proxy: { clientMaxBodySize: "2m" } }),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      expect(h.edge).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
    },
  );
  it.each(["cloud", "cluster"])(
    "rejects resolved %s providers even if they advertise the flag",
    async (target) => {
      h.effectiveTarget = target;
      await expect(
        updateDomain(ctx, "domain-a", { proxy: { clientMaxBodySize: "2m" } }),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      expect(h.update).not.toHaveBeenCalled();
    },
  );
  it("does not upgrade an undeployed noop instance to a local nginx provider", async () => {
    h.project.activeDeploymentId = null;
    h.supports = false;
    await expect(
      updateDomain(ctx, "domain-a", { proxy: { clientMaxBodySize: "2m" } }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(h.withPlatform).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it.each(["paused", "predeployment"])(
    "pending %s settings still require affirmative provider support",
    async (state) => {
      if (state === "paused") h.project.disabledAt = new Date();
      else h.project.activeDeploymentId = null;
      h.supports = false;
      await expect(
        updateDomain(ctx, "domain-a", { proxy: { clientMaxBodySize: "2m" } }),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      expect(h.update).not.toHaveBeenCalled();
      expect(h.edge).not.toHaveBeenCalled();
      expect(h.reapply).not.toHaveBeenCalled();
    },
  );
  it("resolves the bound server before saving an undeployed project's override", async () => {
    h.project.activeDeploymentId = null;
    h.project.serverId = "server-b";
    await updateDomain(ctx, "domain-a", { proxy: { clientMaxBodySize: "2m" } });
    expect(h.withPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-a",
        meta: { deployTarget: "server", serverId: "server-b" },
      }),
      expect.any(Function),
    );
  });
  it.each([null, {}])(
    "allows clearing a legacy override (%j) without inventing application proof",
    async (proxy) => {
      h.project.workspaceId = "legacy-cloud";
      h.supports = false;
      h.edge.mockResolvedValue({ reachable: false, hosts: [] });
      const result = await updateDomain(ctx, "domain-a", { proxy });
      expect(result.proxy).toEqual(proxy);
      expect(result).not.toHaveProperty("applied");
      expect(h.withPlatform).not.toHaveBeenCalled();
      expect(h.edge).not.toHaveBeenCalled();
    },
  );
  it.each(["throw", "warning"])(
    "reports %s apply failures while retaining desired state for retry",
    async (failure) => {
      h.reapply.mockImplementation(async (_project, _hosts, options) => {
        if (failure === "throw") throw new Error("nginx config test failed");
        options.onWarning("nginx reload failed");
      });
      await expect(
        updateDomain(ctx, "domain-a", { proxy: { clientMaxBodySize: "2m" } }),
      ).rejects.toMatchObject({ code: "DOMAIN_PROXY_APPLY_FAILED", statusCode: 502 });
      expect(h.domain.proxy).toEqual({ clientMaxBodySize: "2m" });
      expect(h.markWarning).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "project-a" }),
        expect.stringContaining(
          failure === "throw" ? "nginx config test failed" : "nginx reload failed",
        ),
      );
    },
  );
});
