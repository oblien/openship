import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  owner: { projectId: "project-a", organizationId: "org-a" },
  resolve: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    service: { findById: async () => ({ id: "service-a", name: "web", projectId: "project-a" }) },
    project: {
      findById: async () => ({
        id: "project-a",
        organizationId: "org-a",
        activeDeploymentId: "deployment-a",
      }),
    },
    deployment: { findById: async () => ({ id: "deployment-a", ...h.owner }) },
  },
}));
vi.mock("../../../src/lib/ws", () => ({ upgradeWebSocket: (fn: unknown) => fn }));
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/platform/engine/lib/authorization", () => ({ checkPermission: async () => true }));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: h.resolve,
  disposeRuntime: h.dispose,
}));
vi.mock("@repo/platform/engine/modules/services/service-container", () => ({
  containerIdForService: async () => "container-a",
  liveContainerIdWithRuntime: async () => "container-a",
}));

const { issueTicket } =
  await import("../../../src/modules/service-terminal/service-terminal.controller");
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("ctx" as never, { userId: "user-a", organizationId: "org-a" } as never);
  await next();
});
app.post("/ticket", issueTicket);
const ticket = () =>
  app.request("/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceId: "service-a" }),
  });

beforeEach(() => {
  h.owner = { projectId: "project-a", organizationId: "org-a" };
  h.resolve.mockReset().mockResolvedValue({
    runtime: { name: "docker", supports: () => true, openServiceShell: vi.fn() },
  });
  h.dispose.mockReset();
});

describe("service terminal active-deployment ownership", () => {
  it.each([
    { projectId: "project-b", organizationId: "org-a" },
    { projectId: "project-a", organizationId: "org-b" },
  ])(
    "refuses a foreign workload even for an administrator of the requested project: %j",
    async (owner) => {
      h.owner = owner;
      expect((await ticket()).status).toBe(404);
      expect(h.resolve).not.toHaveBeenCalled();
    },
  );

  it("issues a ticket for an owned workload and releases the probe runtime", async () => {
    const response = await ticket();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(h.resolve).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
  });
});
