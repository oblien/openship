import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@repo/db";

const h = vi.hoisted(() => ({
  project: vi.fn(),
  deployment: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  groupCreate: vi.fn(),
  server: vi.fn(),
}));
vi.mock("@repo/db", async (original) => {
  const actual = await original<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: {
        ...actual.repos.project,
        findById: h.project,
        findBySlugInOrg: async () => null,
        update: h.update,
        create: h.create,
      },
      projectGroup: {
        ...actual.repos.projectGroup,
        findBySlugInOrg: async () => null,
        create: h.groupCreate,
      },
      deployment: { ...actual.repos.deployment, findById: h.deployment },
    },
  };
});
vi.mock("@repo/platform/engine/lib/server-target", () => ({ requireOrgServer: h.server }));

import {
  createProject,
  ensureProject,
  updateProject,
} from "@repo/platform/engine/modules/projects/project-crud.service";
import {
  assertCloudRoutingCapabilities,
  assertProjectRoutingCapabilities,
} from "@repo/platform/engine/modules/projects/project-routing-capabilities";

const base = {
  id: "p1",
  organizationId: "org1",
  serverId: null,
  workspaceId: "ws1",
  activeDeploymentId: null,
} as Project;
const routingConfig = { proxy: { gzip: false } };
const refusal = { statusCode: 400, code: "CLOUD_PROXY_SETTINGS_UNSUPPORTED" };

beforeEach(() => {
  vi.clearAllMocks();
  h.project.mockResolvedValue(base);
  h.deployment.mockResolvedValue(undefined);
  h.server.mockResolvedValue({ id: "server1", workspaceId: "ws1" });
});

describe("Cloud proxy capability at project write boundaries", () => {
  it.each(["update", "ensure", "create", "ensure-create"])(
    "rejects %s before any project/group write",
    async (entry) => {
      const body = { name: "site", serverId: "server1", routingConfig };
      const operation =
        entry === "update"
          ? updateProject(base.id, { routingConfig, port: 8000 }, base.organizationId)
          : entry === "ensure"
            ? ensureProject(
                { name: "site", routingConfig, projectId: base.id },
                base.organizationId,
              )
            : entry === "create"
              ? createProject(body, base.organizationId)
              : ensureProject(body, base.organizationId);
      await expect(operation).rejects.toMatchObject(refusal);
      expect(h.update).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
      expect(h.groupCreate).not.toHaveBeenCalled();
    },
  );

  it("recognizes an owned legacy Cloud deployment without a workspace binding", async () => {
    h.project.mockResolvedValue({ ...base, workspaceId: null, activeDeploymentId: "d1" });
    h.deployment.mockResolvedValue({
      id: "d1",
      projectId: base.id,
      organizationId: base.organizationId,
      meta: { deployTarget: "cloud" },
    });
    await expect(
      updateProject(base.id, { routingConfig }, base.organizationId),
    ).rejects.toMatchObject(refusal);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("keeps a durable Cloud binding authoritative over stale server metadata", async () => {
    h.deployment.mockResolvedValue({
      id: "d1",
      projectId: base.id,
      organizationId: base.organizationId,
      meta: { deployTarget: "server" },
    });
    await expect(
      assertProjectRoutingCapabilities({ ...base, activeDeploymentId: "d1" }, routingConfig),
    ).rejects.toMatchObject(refusal);
  });

  it("allows unchanged legacy settings regardless of object key order", async () => {
    const project = { ...base, routingConfig: { proxy: { gzip: false, proxyReadTimeout: "30s" } } };
    await expect(
      assertProjectRoutingCapabilities(project, {
        proxy: { proxyReadTimeout: "30s", gzip: false },
        cleanUrls: true,
      }),
    ).resolves.toBeUndefined();
    expect(h.deployment).not.toHaveBeenCalled();
  });

  it("rejects changes to a previously saved unsupported Cloud value", async () => {
    h.project.mockResolvedValue({ ...base, routingConfig: { proxy: { gzip: true } } });
    await expect(
      updateProject(base.id, { routingConfig }, base.organizationId),
    ).rejects.toMatchObject(refusal);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("allows self-hosted proxy settings despite a foreign Cloud snapshot", async () => {
    h.deployment.mockResolvedValue({
      id: "d1",
      projectId: "foreign",
      organizationId: base.organizationId,
      meta: { deployTarget: "cloud" },
    });
    await expect(
      assertProjectRoutingCapabilities(
        { ...base, workspaceId: null, serverId: "selfhost", activeDeploymentId: "d1" },
        routingConfig,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    undefined,
    null,
    {},
    { proxy: {} },
    {
      redirects: [{ source: "/old", destination: "/new", permanent: true }],
      cleanUrls: true,
      trailingSlash: false,
    },
  ])("allows supported rules and removal of legacy proxy settings: %j", async (routing) => {
    await expect(assertProjectRoutingCapabilities(base, routing)).resolves.toBeUndefined();
    expect(h.deployment).not.toHaveBeenCalled();
  });

  it("rejects every nonempty proxy object, including explicit false, while preserving selfhost", () => {
    for (const proxy of [{ gzip: false }, { clientMaxBodySize: "50m" }, { http2: true }]) {
      expect(() => assertCloudRoutingCapabilities({ proxy }, true)).toThrow(
        expect.objectContaining(refusal),
      );
      expect(() => assertCloudRoutingCapabilities({ proxy }, false)).not.toThrow();
    }
  });
});
