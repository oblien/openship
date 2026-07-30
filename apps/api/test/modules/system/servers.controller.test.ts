import { beforeEach, describe, expect, it, vi } from "vitest";

const { getInOrganization, deleteServerRow, countActiveOnServer, deleteForResource, getRequestContext, assert } =
  vi.hoisted(() => ({
    getInOrganization: vi.fn(),
    deleteServerRow: vi.fn(),
    countActiveOnServer: vi.fn(),
    deleteForResource: vi.fn(),
    getRequestContext: vi.fn(),
    assert: vi.fn(),
  }));

vi.mock("@repo/db", () => ({
  repos: {
    server: { getInOrganization, delete: deleteServerRow },
    deployment: { countActiveOnServer },
    resourceGrant: { deleteForResource },
  },
}));
vi.mock("@/lib/openresty-paths", () => ({ invalidateOpenRestyPaths: vi.fn() }));
vi.mock("../../../src/config", () => ({ env: {} }));
vi.mock("../../../src/lib/ssh-manager", () => ({ sshManager: { invalidate: vi.fn() } }));
vi.mock("@/lib/credential-encryption", () => ({ encryptSecretField: vi.fn() }));
vi.mock("../../../src/lib/request-context", () => ({ getRequestContext }));
vi.mock("../../../src/lib/permission", () => ({ permission: { assert } }));
vi.mock("../../../src/lib/audit", () => ({ audit: { recordAsync: vi.fn() }, auditContextFrom: vi.fn() }));
vi.mock("../../../src/lib/controller-helpers", () => ({ assertNotCloud: () => null, param: vi.fn() }));
vi.mock("@/lib/geo-ip", () => ({ primeGeo: vi.fn(), countryForIp: vi.fn() }));

import { deleteServer } from "../../../src/modules/system/servers.controller";

function createContext(id: string, query: Record<string, string> = {}) {
  return {
    req: { param: () => id, query: (k: string) => query[k] },
    json: (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }),
  } as never;
}

describe("servers.controller deleteServer active-deployment guard", () => {
  beforeEach(() => {
    getRequestContext.mockReturnValue({ organizationId: "o1", userId: "u1" });
    assert.mockResolvedValue(undefined);
    getInOrganization.mockResolvedValue({ id: "srv1", name: "box", sshHost: "1.2.3.4" });
    deleteServerRow.mockResolvedValue(undefined);
    deleteForResource.mockResolvedValue(undefined);
    countActiveOnServer.mockReset();
  });

  it("refuses with 409 when the server still has active deployments", async () => {
    countActiveOnServer.mockResolvedValue(2);
    const res = await deleteServer(createContext("srv1"));
    expect(res.status).toBe(409);
    expect(deleteServerRow).not.toHaveBeenCalled();
  });

  it("deletes anyway when force=true (guard bypassed)", async () => {
    countActiveOnServer.mockResolvedValue(2);
    const res = await deleteServer(createContext("srv1", { force: "true" }));
    expect(res.status).toBe(200);
    expect(deleteServerRow).toHaveBeenCalledWith("srv1");
  });

  it("deletes when the server has no active deployments", async () => {
    countActiveOnServer.mockResolvedValue(0);
    const res = await deleteServer(createContext("srv1"));
    expect(res.status).toBe(200);
    expect(deleteServerRow).toHaveBeenCalledWith("srv1");
  });
});
