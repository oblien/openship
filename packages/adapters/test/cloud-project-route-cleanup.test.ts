import { beforeEach, describe, expect, it } from "vitest";
import { CloudInfraProvider } from "../src/infra/cloud";
import { cloudDockerProjectPaths } from "../src/runtime/cloud/docker-paths";
import { managedRoutingFixture } from "./managed-routing-fixture";

let h: ReturnType<typeof managedRoutingFixture>;
beforeEach(async () => {
  h = managedRoutingFixture();
  await h.infra.registerRoute({
    domain: "app.opsh.io",
    targetUrl: "http://127.0.0.1:3000",
    tls: true,
  });
});

describe("project-scoped route cleanup", () => {
  it.each(["workspace-one", "another-workspace"])(
    "preserves a different project's Page on %s while explicit removal stays strict",
    async (workspaceId) => {
      h.records.get("app")!.source_workspace_id = workspaceId;
      h.records.get("app")!.exported_path =
        `${cloudDockerProjectPaths("active-project").routes}/app`;
      const activePage = structuredClone(h.records.get("app"));

      await expect(h.infra.removeProjectRoute("app.opsh.io")).resolves.toBe("foreign");
      await expect(h.infra.removeRoute("app.opsh.io")).rejects.toThrow("not owned");
      expect(h.records.get("app")).toEqual(activePage);
      expect(h.pages.delete).not.toHaveBeenCalled();
    },
  );

  it("checks fresh ownership under the mutation lock rather than trusting inventory", async () => {
    const inventoried = structuredClone(h.records.get("app"));
    h.pages.list.mockResolvedValue({ pages: [inventoried] });
    let insideLock = false;
    h.scope.lock = {
      run: async (work) => {
        insideLock = true;
        try {
          return await work();
        } finally {
          insideLock = false;
        }
      },
    };
    const read = h.pages.get.getMockImplementation()!;
    h.pages.get.mockImplementation(async (slug) => {
      expect(insideLock).toBe(true);
      return read(slug);
    });
    h.records.get("app")!.exported_path = `${cloudDockerProjectPaths("active-project").routes}/app`;

    await expect(h.infra.removeProjectRoute("app.opsh.io")).resolves.toBe("foreign");
    expect(h.pages.delete).not.toHaveBeenCalled();
  });

  it("removes owned routes idempotently through the same deletion path", async () => {
    await expect(h.infra.removeProjectRoute("app.opsh.io")).resolves.toBe("removed");
    await expect(h.infra.removeProjectRoute("app.opsh.io")).resolves.toBe("absent");
    expect(h.pages.delete).toHaveBeenCalledExactlyOnceWith("app");
  });

  it.each([
    { source_workspace_id: "another-workspace" },
    { exported_path: undefined },
    { exported_path: "/unrecognised-owner/app" },
    { exported_path: `${cloudDockerProjectPaths("active-project").routes}/wrong-slug` },
    {
      exported_path: `${cloudDockerProjectPaths("active-project").routes}/app`,
      source_workspace_id: null,
    },
  ])("blocks deletion when foreign ownership is unproven: %j", async (changes) => {
    Object.assign(h.records.get("app")!, changes);
    await expect(h.infra.removeProjectRoute("app.opsh.io")).rejects.toThrow("not owned");
    expect(h.pages.delete).not.toHaveBeenCalled();
  });

  it("rejects missing project scope instead of treating everything as foreign", async () => {
    const unscoped = new CloudInfraProvider(h.client, {
      namespace: h.namespace,
      workspaceId: h.workspaceId,
      lock: h.scope.lock,
    });
    await expect(unscoped.removeProjectRoute("app.opsh.io")).rejects.toThrow(
      "owning managed server and project",
    );
    expect(h.pages.delete).not.toHaveBeenCalled();
  });

  it("does not hide read failures or a changed custom-domain binding", async () => {
    h.pages.get.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(h.infra.removeProjectRoute("app.opsh.io")).rejects.toThrow("provider unavailable");
    h.records.get("app")!.custom_domain = "app.example.com";
    h.pages.getDomain.mockResolvedValue({ domain: { customDomain: "replacement.example.com" } });
    await expect(h.infra.removeProjectRoute("app.example.com")).rejects.toThrow("binding changed");
    expect(h.pages.delete).not.toHaveBeenCalled();
  });
});
