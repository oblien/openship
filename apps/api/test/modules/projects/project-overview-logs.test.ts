import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import { projectFixture } from "../../../../../packages/contracts/test/fixtures";

const h = vi.hoisted(() => ({
  list: vi.fn(), enrich: vi.fn(), cloudProjects: vi.fn(), members: vi.fn(), stats: vi.fn(),
  canRead: vi.fn(), source: vi.fn(), sources: vi.fn(), fetchMgmt: vi.fn(),
  streamToken: vi.fn(), requests: vi.fn(), server: vi.fn(),
  env: { CLOUD_MODE: false },
}));
vi.mock("@repo/db", () => ({ repos: {
  project: { findById: async (id: string) => ({ id, organizationId: "org-a" }) },
  deployment: { findLatestByProjects: async () => new Map(), statsByProjects: h.stats },
  domain: { getPrimariesByProjects: async () => new Map() },
  service: { listByProjects: async () => new Map() },
  member: { listByUser: h.members }, organization: { findManyById: async () => [] },
  server: { get: h.server },
} }));
vi.mock("@repo/platform/engine/modules/projects/project.service", () => ({ listProjects: h.list, enrichProjectsBatch: h.enrich, deploymentIsBlocked: () => false }));
vi.mock("@repo/platform/engine/lib/authorization", () => ({ authorization: { checkPermissionOnResource: h.canRead, authorize: async (ctx: ExecutionContext) => ctx } }));
vi.mock("@repo/platform/engine/lib/cloud/projects", () => ({ fetchOrgCloudProjects: h.cloudProjects }));
vi.mock("@repo/platform/engine/lib/favicon-detector", () => ({ refreshProjectFaviconIfStale: vi.fn() }));
vi.mock("@repo/platform/engine/config/index", () => ({ env: h.env }));
vi.mock("@repo/platform/engine/lib/oblien-user-client", () => ({ getAdminOblienClient: () => h.env.CLOUD_MODE ? { analytics: { streamToken: h.streamToken, requests: h.requests } } : null }));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: () => ({ analytics: { streamToken: h.streamToken, requests: h.requests } }) }));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: {} }));
vi.mock("@repo/platform/engine/lib/openresty-paths", () => ({ getOpenRestyPaths: vi.fn() }));
vi.mock("@repo/platform/engine/lib/project-analytics", () => ({
  resolveProjectTrafficSource: h.source, resolveProjectTrafficSources: h.sources,
  fetchMgmt: h.fetchMgmt, mgmtStream: vi.fn(), probeMgmt: vi.fn(),
}));
import { getProjectHome } from "@repo/platform/engine/modules/projects/project-home.operations";
import { projectLogOperations } from "@repo/platform/engine/modules/projects/project-logs.operations";

const context = { userId: "alice", organizationId: "org-a", role: "owner", scopeMode: "fixed" } as ExecutionContext;
beforeEach(() => {
  vi.clearAllMocks();
  h.env.CLOUD_MODE = false;
  h.list.mockResolvedValue({ rows: [], total: 0 });
  h.enrich.mockImplementation(async rows => rows);
  h.cloudProjects.mockResolvedValue({ state: "not-connected" });
  h.members.mockResolvedValue([]);
  h.stats.mockResolvedValue({ total: 0, success: 0 });
  h.server.mockResolvedValue({ id: "server-a", organizationId: "org-a", isLocal: false });
  h.canRead.mockImplementation(async (_ctx, input) => input.resourceId === "visible");
});

describe("shared project home", () => {
  it("filters restricted identities before enrichment/counting and masks stored secrets", async () => {
    const rows = [projectFixture("hidden"), { ...projectFixture("visible"), cloneTokenEncrypted: "encrypted", webhookSecret: "private" }];
    h.list.mockImplementation(async (_org, input) => {
      expect(input.perPage).toBe(100);
      const allowed = [];
      for (const row of rows) if (await input.canRead(row.id)) allowed.push(row);
      return { rows: allowed, total: allowed.length };
    });
    const result = await getProjectHome({ ...context, role: "restricted" });
    expect(result.projects).toEqual([expect.objectContaining({ id: "visible", source: "local" })]);
    expect(result.numbers.total_projects).toBe(1);
    expect(h.stats).toHaveBeenCalledWith(["visible"]);
    expect(JSON.stringify(result)).not.toContain("encrypted");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(h.members).not.toHaveBeenCalled();
    expect(h.cloudProjects).not.toHaveBeenCalled();
  });
  it("keeps fixed organization views isolated while retaining legacy account cloud merges", async () => {
    h.cloudProjects.mockResolvedValue({ state: "merged", projects: [projectFixture("cloud", "Cloud", "cloud-org")], numbers: { total_projects: 1, total_deployments: 4, total_success_deployments: 3 } });
    expect((await getProjectHome(context)).projects).toEqual([]);
    expect(h.cloudProjects).not.toHaveBeenCalled();
    expect(h.members).not.toHaveBeenCalled();
    const legacy = await getProjectHome({ ...context, scopeMode: "resource" });
    expect(legacy.projects).toEqual([expect.objectContaining({ id: "cloud", source: "cloud" })]);
    expect(legacy.numbers).toEqual({ total_projects: 1, total_active_projects: 1, total_deployments: 4, total_success_deployments: 3 });
  });
  it("retains first-boot empty state and reports other storage failures", async () => {
    h.list.mockRejectedValueOnce(new Error('relation "project" does not exist'));
    expect(await getProjectHome(context)).toMatchObject({ success: true, projects: [], otherOrgs: [] });
    h.list.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(getProjectHome(context)).rejects.toMatchObject({ code: "LIST_FAILED", statusCode: 500, details: { success: false, message: "storage unavailable" } });
  });
});

describe("shared project traffic logs", () => {
  it("merges domains, preserves existing host labels and sorts ISO/second/millisecond timestamps together", async () => {
    h.env.CLOUD_MODE = true;
    h.sources.mockResolvedValue([
      { kind: "self-hosted", domain: "local.example.com", serverId: "server-a" },
      { kind: "cloud", domain: "cloud.example.com" },
      { kind: "cloud", domain: "unavailable.example.com" },
    ]);
    h.fetchMgmt.mockResolvedValue([{ ts: 1_800_000_000, path: "/old" }, { ts: 1_800_000_002_000, path: "/middle", host: "original" }]);
    h.requests.mockImplementation(async domain => {
      if (domain === "unavailable.example.com") throw new Error("offline");
      return { data: { result: { requests: [{ timestamp: new Date(1_800_000_003_000).toISOString(), path: "/latest" }] } } };
    });
    const result = await projectLogOperations.recentServerLogs(context, "project-a", { limit: 2 });
    expect(result).toEqual({ logs: [
      { timestamp: new Date(1_800_000_003_000).toISOString(), path: "/latest", host: "cloud.example.com" },
      { ts: 1_800_000_002_000, path: "/middle", host: "original" },
    ] });
  });
  it("does not turn cloud token failures into a self-hosted stream", async () => {
    h.env.CLOUD_MODE = true;
    h.source.mockResolvedValue({ kind: "cloud", domain: "cloud.example.com" });
    h.streamToken.mockRejectedValueOnce(new Error("offline"));
    expect(await projectLogOperations.getServerLogStreamToken(context, "project-a")).toEqual({ kind: "unavailable" });
    h.streamToken.mockResolvedValueOnce({ data: { result: { stream_url: "https://edge.test/stream", token: "provider-token" } } });
    expect(await projectLogOperations.getServerLogStreamToken(context, "project-a")).toEqual({ kind: "cloud", url: "https://edge.test/stream", token: "provider-token" });
  });
  it("refuses unmapped cloud scopes and foreign server snapshots before upstream requests", async () => {
    h.source.mockResolvedValue({ kind: "cloud", domain: "cloud.example.com" });
    await expect(projectLogOperations.getServerLogStreamToken(context, "project-a")).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    h.sources.mockResolvedValue([{ kind: "self-hosted", domain: "local.example.com", serverId: "foreign" }]);
    h.server.mockResolvedValue({ id: "foreign", organizationId: "org-b" });
    await expect(projectLogOperations.recentServerLogs(context, "project-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.streamToken).not.toHaveBeenCalled();
    expect(h.fetchMgmt).not.toHaveBeenCalled();
  });
});
