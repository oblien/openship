import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the custom-app repo (keyed by org+appId).
const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock("@repo/db", () => ({
  repos: {
    customAppTemplate: {
      upsert: async (d: { organizationId: string; appId: string; template: unknown }) => {
        store.set(`${d.organizationId}:${d.appId}`, d.template);
        return {};
      },
      findByAppId: async (org: string, appId: string) => {
        const t = store.get(`${org}:${appId}`);
        return t ? { template: t } : undefined;
      },
      listByOrg: async (org: string) => {
        const rows: { appId: string; organizationId: string; template: unknown }[] = [];
        for (const [key, value] of store.entries()) {
          const [entryOrg, appId] = key.split(":");
          if (entryOrg === org) rows.push({ appId, organizationId: org, template: value });
        }
        return rows;
      },
      deleteByAppId: async () => {},
    },
  },
}));

import { saveCustomApp } from "@repo/platform/engine/modules/apps/custom-app.service";
import { getTemplateForOrg } from "@repo/platform/engine/modules/apps/catalog-source";
import { listOrgCustomApps } from "@repo/platform/engine/modules/apps/catalog-source";
import type { RequestContext } from "../../../src/lib/request-context";

const ctx = (organizationId: string) => ({ organizationId, userId: "u1" }) as RequestContext;

const validApp = {
  id: "my-custom",
  name: "My Custom",
  description: "A custom app",
  kind: "template",
  logo: "box",
  category: "other",
  services: [{ name: "app", image: "nginx:1.27", exposedPort: 80, exposed: true }],
};

describe("custom apps — saveCustomApp validation + trust", () => {
  beforeEach(() => store.clear());

  it("stores a valid template and resolves it (unverified) for the org", async () => {
    await saveCustomApp(ctx("org1"), validApp);
    const t = await getTemplateForOrg("org1", "my-custom");
    expect(t?.name).toBe("My Custom");
    expect(t?.verified).toBe(false);
    expect(t?.custom).toBe(true);
  });

  it("forces verified:false even when the JSON claims verified:true", async () => {
    await saveCustomApp(ctx("org1"), { ...validApp, verified: true, available: true });
    const stored = store.get("org1:my-custom") as { verified?: boolean };
    expect(stored.verified).toBe(false);
  });

  it("rejects a malformed template", async () => {
    await expect(saveCustomApp(ctx("org1"), { id: "x" })).rejects.toThrow();
  });

  it("rejects a flow app", async () => {
    await expect(
      saveCustomApp(ctx("org1"), { ...validApp, kind: "flow", flowHref: "/x", services: undefined }),
    ).rejects.toThrow(/template apps/i);
  });

  it("rejects shadowing a built-in app id", async () => {
    await expect(saveCustomApp(ctx("org1"), { ...validApp, id: "mongodb" })).rejects.toThrow(/built-in/i);
  });

  it("isolates custom apps per org", async () => {
    await saveCustomApp(ctx("orgA"), validApp);
    expect(await getTemplateForOrg("orgA", "my-custom")).toBeDefined();
    expect(await getTemplateForOrg("orgB", "my-custom")).toBeUndefined();
  });

  it("skips invalid custom apps from listOrgCustomApps and getTemplateForOrg without throwing", async () => {
    // Simulate corrupt row in DB (e.g. legacy/invalid definition)
    store.set("org1:corrupt", { name: "Corrupt", category: "security" });
    store.set("org1:valid", { ...validApp, id: "valid" });

    const list = await listOrgCustomApps("org1");
    expect(list.map((a) => a.id)).toEqual(["valid"]);

    expect(await getTemplateForOrg("org1", "corrupt")).toBeUndefined();
    expect(await getTemplateForOrg("org1", "valid")).toBeDefined();
  });
});
