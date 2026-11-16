import { beforeEach, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import type { CompiledEdgePages, ProjectEdgePages } from "@repo/core";
const h = vi.hoisted(() => ({
  project: {} as Record<string, any>,
  target: "local",
  deployment: true,
  persisted: vi.fn(),
  publish: vi.fn(),
  read: vi.fn(),
  admission: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: async () => h.project, update: h.persisted },
    domain: { listByProject: async () => [{ id: "host", hostname: "site.test" }] },
  },
}));
vi.mock("@repo/platform/engine/lib/active-deployment", () => ({
  findActiveDeployment: async () => (h.deployment ? { id: "release" } : null),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  withDeploymentPlatform: async (_: unknown, work: Function) =>
    work({ routing: { setRouteEdgePages: h.publish, getRouteEdgePages: h.read } }),
}));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withProjectRuntimeLock: async (_: string, work: Function) => work(),
}));
vi.mock("@repo/platform/engine/lib/route-protection", () => ({
  withRouteProtectionLock: async (_: string, work: Function) => work(),
}));
vi.mock("@repo/platform/engine/modules/projects/project-deploy-target", () => ({
  resolveProjectDeployTarget: async () => ({ deployTarget: h.target }),
}));
vi.mock("@repo/platform/engine/modules/domains/domain-execution", () => ({
  domainExecution: h.admission,
}));
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { recordAsync: vi.fn() },
  operationAuditContext: () => ({}),
}));
import { projectEdgePageResources as pages } from "@repo/platform/engine/modules/projects/project-edge-pages.operations";
import { assertProjectEdgePagesTarget } from "@repo/platform/engine/modules/projects/project-routing-capabilities";
const ctx = { organizationId: "org" } as ExecutionContext;
const config: ProjectEdgePages = {
  defaults: { files: [], errors: [], maintenance: { enabled: true, retryAfter: 300 } },
};
beforeEach(() => {
  vi.resetAllMocks();
  h.target = "local";
  h.deployment = true;
  h.project = { id: "project", organizationId: "org", routingConfig: { cleanUrls: true } };
  h.persisted.mockImplementation(async (_: string, update: object) =>
    Object.assign(h.project, update),
  );
  h.publish.mockResolvedValue(true);
  h.read.mockResolvedValue(null);
});
it("keeps a failed application pending, preserves intent, and retries through the same route provider", async () => {
  const initial = await pages.getEdgePages(ctx, "project");
  h.publish.mockRejectedValueOnce(new Error("edge reload failed"));
  const saved = await pages.updateEdgePages(ctx, "project", {
    config,
    expectedRevision: initial.revision,
  });
  expect(saved).toMatchObject({ config, status: "pending", message: "edge reload failed" });
  expect(h.project.routingConfig).toEqual({ cleanUrls: true, edgePages: config });
  expect(h.persisted.mock.invocationCallOrder[0]).toBeLessThan(
    h.publish.mock.invocationCallOrder[0],
  );
  const retried = await pages.updateEdgePages(ctx, "project", {
    config,
    expectedRevision: saved.revision,
  });
  expect(retried.status).toBe("applied");
  const compiled: CompiledEdgePages = {
    errors: {},
    maintenance: { enabled: true, retryAfter: 300 },
  };
  expect(h.publish).toHaveBeenLastCalledWith("site.test", compiled);
  h.read.mockResolvedValue(compiled);
  expect((await pages.getEdgePages(ctx, "project")).status).toBe("applied");
  h.read.mockResolvedValue(undefined);
  expect((await pages.getEdgePages(ctx, "project")).status).toBe("pending");
});
it.each(["cloud", "workspace", "cluster"])(
  "rejects provider-owned or unsupported target %s before persistence or execution",
  async (kind) => {
    if (kind === "cloud") h.target = "cloud";
    else h.project[kind === "workspace" ? "workspaceId" : "clusterId"] = "provider-owned";
    await expect(
      pages.updateEdgePages(ctx, "project", { config, expectedRevision: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "EDGE_PAGES_UNSUPPORTED" });
    expect(h.persisted).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  },
);
it("checks tenant and native host permission before saving or touching an edge", async () => {
  await expect(
    pages.getEdgePages({ organizationId: "foreign" } as ExecutionContext, "project"),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(h.read).not.toHaveBeenCalled();
  const initial = await pages.getEdgePages(ctx, "project");
  h.admission.mockRejectedValue(new Error("Host execution is disabled"));
  await expect(
    pages.updateEdgePages(ctx, "project", { config, expectedRevision: initial.revision }),
  ).rejects.toThrow("Host execution is disabled");
  expect(h.persisted).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});
it("drops unchanged overrides for deleted domains without accepting new unowned-host settings", async () => {
  h.project.routingConfig = { edgePages: { hosts: { "removed.test": config.defaults } } };
  const previous = await pages.getEdgePages(ctx, "project");
  await expect(
    pages.updateEdgePages(ctx, "project", {
      config: { hosts: { "removed.test": { files: [], errors: [] } } },
      expectedRevision: previous.revision,
    }),
  ).rejects.toMatchObject({ code: "INVALID_DOMAIN" });
  expect(h.persisted).not.toHaveBeenCalled();
  const saved = await pages.updateEdgePages(ctx, "project", {
    config: previous.config,
    expectedRevision: previous.revision,
  });
  expect(saved.config).toEqual({ hosts: {} });
});
it.each(["cloud", "cluster"])("guards a move to %s only while pages need an edge", (target) => {
  expect(() =>
    assertProjectEdgePagesTarget({ routingConfig: { edgePages: config } }, target),
  ).toThrow("Remove their assignments");
  expect(() =>
    assertProjectEdgePagesTarget(
      {
        routingConfig: {
          edgePages: {
            hosts: { "site.test": config.defaults! },
          },
        },
      },
      target,
    ),
  ).toThrow("Remove their assignments");
  expect(() =>
    assertProjectEdgePagesTarget(
      {
        routingConfig: {
          edgePages: {
            defaults: {
              files: [{ id: "unused", name: "unused.html", html: "<h1>Unused</h1>" }],
              errors: [],
              maintenance: { enabled: false, retryAfter: 300 },
            },
          },
        },
      },
      target,
    ),
  ).not.toThrow();
});
