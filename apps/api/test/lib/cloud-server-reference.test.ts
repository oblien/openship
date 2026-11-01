import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ server: vi.fn(), workspace: vi.fn(), link: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: { server: { get: h.server }, cloudWorkspace: { findById: h.workspace } } }));
vi.mock("@repo/platform/engine/lib/cloud/server-link", () => ({ requireLinkedCloudServer: h.link }));
import { cloudRequestReferences } from "@repo/platform/engine/lib/cloud/server-reference";
beforeEach(() => {
  vi.resetAllMocks();
  h.server.mockImplementation(async id => id === "local-server" ? { organizationId: "local-org", workspaceId: "local-workspace" } : null);
  h.workspace.mockImplementation(async id => id === "local-workspace" ? { id } : null);
  h.link.mockResolvedValue({ remote: { serverId: "cloud-server", workspaceId: "cloud-workspace" } });
});
describe("canonical Cloud request references", () => {
  it("maps verified execution links without rewriting user content", async () => {
    const input = { serverId: "local-server", buildServerId: "local-server", workspaceId: "local-workspace", environment: { serverId: "local-server" }, command: "local-server" };
    expect(await cloudRequestReferences("local-org", input)).toEqual({ ...input, serverId: "cloud-server", buildServerId: "cloud-server", workspaceId: "cloud-workspace" });
    expect(input.serverId).toBe("local-server");
    expect(h.link).toHaveBeenCalledWith("local-org", "local-workspace");
  });
  it("leaves Cloud-only references for Cloud authorization", async () => {
    const input = { serverId: "cloud-server", workspaceId: "cloud-workspace" };
    expect(await cloudRequestReferences("local-org", input)).toEqual(input);
    expect(h.link).not.toHaveBeenCalled();
  });
  it("rejects foreign local servers and local SSH hosts before sending a request", async () => {
    h.server.mockResolvedValueOnce({ organizationId: "foreign-org", workspaceId: "foreign-workspace" });
    await expect(cloudRequestReferences("local-org", { serverId: "foreign" })).rejects.toMatchObject({ statusCode: 404 });
    h.server.mockResolvedValueOnce({ organizationId: "local-org", workspaceId: null });
    await expect(cloudRequestReferences("local-org", { serverId: "ssh-host" })).rejects.toMatchObject({ code: "CLOUD_SERVER_REQUIRED" });
    expect(h.link).not.toHaveBeenCalled();
  });
  it("refuses a linked workspace when its verified connection is no longer available", async () => {
    h.link.mockRejectedValue(new Error("Cloud connection changed"));
    await expect(cloudRequestReferences("local-org", { workspaceId: "local-workspace" })).rejects.toThrow("Cloud connection changed");
  });
});
