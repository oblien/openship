import { beforeEach, describe, expect, it, vi } from "vitest";

const { getRequestContext, assert, maybeProxyCloudProject, triggerDeployment } = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  assert: vi.fn(),
  maybeProxyCloudProject: vi.fn(),
  triggerDeployment: vi.fn(),
}));

vi.mock("../../../src/lib/request-context", () => ({ getRequestContext }));
vi.mock("../../../src/lib/permission", () => ({ permission: { assert } }));
vi.mock("../../../src/lib/cloud/project-router", () => ({
  maybeProxyCloudProject,
  proxyToSaaS: vi.fn(),
}));
vi.mock("../../../src/modules/deployments/build.service", () => ({ triggerDeployment }));
// Sibling imports the create() path never touches — stub so their heavy graphs
// don't load.
vi.mock("../../../src/lib/sse", () => ({ streamSSE: vi.fn() }));
vi.mock("../../../src/modules/deployments/deployment.service", () => ({}));
vi.mock("../../../src/modules/deployments/reconcile.service", () => ({ triggerReconcile: vi.fn() }));
vi.mock("../../../src/modules/deployments/build-status.service", () => ({}));
vi.mock("../../../src/modules/deployments/ssl.service", () => ({}));
vi.mock("../../../src/modules/deployments/prepare.service", () => ({}));
vi.mock("../../../src/modules/projects/transfer.service", () => ({
  promoteProjectToCloud: vi.fn(),
  TransferConflictError: class extends Error {},
}));
vi.mock("../../../src/config", () => ({ env: {} }));

import { create } from "../../../src/modules/deployments/deployment.controller";

function createContext(body: unknown) {
  return {
    req: { json: async () => body, query: () => undefined },
    json: (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as never;
}

describe("deployment.controller create", () => {
  beforeEach(() => {
    getRequestContext.mockReturnValue({ organizationId: "org1", userId: "u1" });
    assert.mockResolvedValue(undefined);
    maybeProxyCloudProject.mockResolvedValue(null); // not a cloud project
  });

  it("responds with the { deployment_id, project_id } contract the CLI/dashboard read", async () => {
    triggerDeployment.mockResolvedValue({ deployment: { id: "dep_x", projectId: "proj_1" } });

    const res = await create(createContext({ projectId: "proj_1", branch: "main" }));
    expect(res.status).toBe(202);

    const body = (await res.json()) as { data: { deployment_id?: string; project_id?: string } };
    expect(body.data.deployment_id).toBe("dep_x");
    expect(body.data.project_id).toBe("proj_1");
  });
});
