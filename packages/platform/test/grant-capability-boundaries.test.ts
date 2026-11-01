import { describe, expect, it } from "vitest";
import { createAuthorization } from "../src";
import { alice, authorizationFixture } from "./fixtures";

describe("PR 1304 capability boundaries", () => {
  it("keeps capability grants inside the bound organization, rejects unrelated operations and read-only writes", async () => {
    const state = authorizationFixture();
    for (const suffix of ["a", "b"]) {
      state.members.set(`org-${suffix}:alice`, { id: `member-${suffix}`, role: "owner" });
      state.projects.set(`project-${suffix}`, { organizationId: `org-${suffix}` });
      state.domains.set(`domain-${suffix}`, { projectId: `project-${suffix}` });
      state.deployments.set(`deployment-${suffix}`, { projectId: `project-${suffix}` });
      state.tokenGrants.set(`token-a:project:project-${suffix}`, {
        permissions: [
          "domains:read",
          "domains:write",
          "domains:delete",
          "deployments:read",
          "deployments:trigger",
        ] as never,
      });
    }
    const auth = createAuthorization(state);
    const ctx = await auth.resolveScope(
      { ...alice, tokenScope: { tokenId: "token-a" }, credential: { organizationId: "org-a" } },
      "org-a",
    );
    for (const type of ["domain", "deployment"] as const) {
      expect(
        await auth.checkPermissionOnResource(ctx, {
          resourceType: type,
          resourceId: `${type}-a`,
          action: "read",
        }),
      ).toBe(true);
      expect(
        await auth.checkPermissionOnResource(ctx, {
          resourceType: type,
          resourceId: `${type}-b`,
          action: "read",
        }),
      ).toBe(false);
    }
    for (const action of ["read", "write", "admin"] as const) {
      expect(
        await auth.checkPermissionOnResource(ctx, {
          resourceType: "project",
          resourceId: "project-a",
          action,
        }),
      ).toBe(false);
    }
    const readOnly = { ...ctx, credential: { ...ctx.credential, readOnly: true } };
    expect(
      await auth.checkPermissionOnResource(readOnly, {
        resourceType: "domain",
        resourceId: "domain-a",
        action: "read",
      }),
    ).toBe(true);
    expect(
      await auth.checkPermissionOnResource(readOnly, {
        resourceType: "domain",
        resourceId: "domain-a",
        action: "write",
      }),
    ).toBe(false);
    expect(
      await auth.checkPermissionOnResource(ctx, {
        resourceType: "deployment",
        resourceId: "deployment-a",
        action: "admin",
      }),
    ).toBe(false);
  });
});
