import { beforeEach, describe, expect, it } from "vitest";
import { managedRoutingFixture } from "../../test/managed-routing-fixture";
let h: ReturnType<typeof managedRoutingFixture>;
beforeEach(() => { h = managedRoutingFixture(); });

describe("shared static releases on managed ingress", () => {
  it.each([".", "dist"])("normalizes %s under its owned release and exports only the project route tree", async output => {
    await h.infra.registerRoute({ domain: "site.opsh.io", staticRoot: `${h.scope.staticReleaseRoot}/release-a/${output}`, tls: true });
    expect(h.pages.create).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: h.workspaceId, path: `${h.paths.routes}/site` }));
    expect(h.scope.resolveUrl).not.toHaveBeenCalled();
    expect(h.routes.set).toHaveBeenCalledOnce();
  });
  it.each(["/etc", "/another-project/releases/site"])("refuses a static source outside the project: %s", async staticRoot => {
    await expect(h.infra.registerRoute({ domain: "site.opsh.io", staticRoot, tls: true })).rejects.toThrow("outside");
    expect(h.pages.create).not.toHaveBeenCalled();
    expect(h.executor.exec).not.toHaveBeenCalled();
  });
  it("rejects a symlink escaping the release tree before export", async () => {
    h.executor.exec.mockResolvedValueOnce("/etc");
    await expect(h.infra.registerRoute({ domain: "site.opsh.io", staticRoot: `${h.scope.staticReleaseRoot}/release-a`, tls: true })).rejects.toThrow("outside");
    expect(h.pages.create).not.toHaveBeenCalled();
  });
  it("does not replace a Page when its ownership cannot be read", async () => {
    h.pages.get.mockRejectedValue(new Error("provider unavailable"));
    await expect(h.infra.registerRoute({ domain: "site.opsh.io", staticRoot: `${h.scope.staticReleaseRoot}/release-a`, tls: true })).rejects.toThrow("provider unavailable");
    expect(h.pages.create).not.toHaveBeenCalled();
    expect(h.executor.exec).not.toHaveBeenCalled();
  });
  it("republishes the previous export when edge activation fails", async () => {
    await h.infra.registerRoute({ domain: "site.opsh.io", staticRoot: `${h.scope.staticReleaseRoot}/release-a`, tls: true });
    const original = h.executor.exec.getMockImplementation()!;
    h.executor.exec.mockImplementation(async command => command.includes("printf restored") ? "restored" : original(command));
    h.routes.set.mockRejectedValueOnce(new Error("route table unavailable"));
    await expect(h.infra.registerRoute({ domain: "site.opsh.io", staticRoot: `${h.scope.staticReleaseRoot}/release-b`, tls: true })).rejects.toThrow("route table unavailable");
    expect(h.pages.deploy).toHaveBeenCalledTimes(2);
    expect(h.pages.deploy).toHaveBeenLastCalledWith("site", { workspace_id: h.workspaceId, path: `${h.paths.routes}/site` });
  });
});
