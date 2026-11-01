import { beforeEach, describe, expect, it } from "vitest";
import { CloudInfraProvider } from "../src/infra/cloud";
import { managedRoutingFixture } from "./managed-routing-fixture";
let h: ReturnType<typeof managedRoutingFixture>;
beforeEach(async () => { h = managedRoutingFixture(); await h.infra.registerRoute({ domain: "app.opsh.io", targetUrl: "http://127.0.0.1:3000", tls: true }); });

describe("managed route cleanup", () => {
  it("deletes only the owned Page and remains idempotent", async () => {
    h.records.set("sibling", { ...h.records.get("app"), slug: "sibling", url: "https://sibling.opsh.io", exported_path: "/another-project/sibling" });
    await h.infra.removeRoute("app.opsh.io");
    await h.infra.removeRoute("app.opsh.io");
    expect(h.pages.delete).toHaveBeenCalledExactlyOnceWith("app");
    expect(h.records.has("sibling")).toBe(true);
  });
  it("uses the Page slug when the registry owner has a numeric id", async () => {
    expect(h.records.get("app")!.id).toBe(1);
    await h.infra.removeRoute("app.opsh.io");
    expect(h.pages.delete).toHaveBeenCalledWith("app");
  });
  it("can clean up a disabled Page absent from the active route registry", async () => {
    h.records.get("app")!.status = "disabled";
    h.domain.routes.mockResolvedValue({ data: [] });
    await h.infra.removeRoute("app.opsh.io");
    expect(h.pages.delete).toHaveBeenCalledWith("app");
  });
  it.each(["source_workspace_id", "exported_path"])("refuses cleanup after %s changes", async field => {
    h.records.get("app")![field] = "another-owner";
    await expect(h.infra.removeRoute("app.opsh.io")).rejects.toThrow("not owned");
    expect(h.pages.delete).not.toHaveBeenCalled();
  });
  it("does not treat a provider refusal as a deleted route", async () => {
    h.pages.delete.mockResolvedValue({ success: false });
    await expect(h.infra.removeRoute("app.opsh.io")).rejects.toThrow("Could not remove");
  });
  it("requires an owned server before permitting route cleanup", async () => {
    await expect(new CloudInfraProvider(h.client, { namespace: h.namespace }).removeRoute("app.opsh.io")).rejects.toThrow("owning managed server");
  });
});
