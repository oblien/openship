import { describe, expect, it, vi } from "vitest";
import {
  createAuthorization,
  createProjectOperations,
  createPlatform,
  type ProjectDependencies,
  type DeploymentResourceDependencies,
} from "../src";
import { alice, authorizationFixture, storedDeployment } from "./fixtures";

async function setup() {
  const state = authorizationFixture();
  state.members.set("org-a:alice", { id: "member-a", role: "owner" });
  state.projects.set("project-a", { organizationId: "org-a" });
  state.tokenGrants.set("token-a:project:project-a", { permissions: ["deployments:read"] });
  const auth = createAuthorization(state);
  const ctx = await auth.resolveScope(
    { ...alice, tokenScope: { tokenId: "token-a" }, credential: { organizationId: "org-a" } },
    "org-a",
  );
  return { auth, ctx };
}

describe("project deployment history with capability-only grants", () => {
  it("lists a project's deployments through the shared operation used by GET /projects/:id/deployments", async () => {
    const { auth, ctx } = await setup();
    const response = { data: [], total: 0, page: 1, perPage: 20 };
    const listDeployments = vi.fn(async () => response);
    const projects = createProjectOperations(auth, {
      controls: { listDeployments },
    } as unknown as ProjectDependencies);
    await expect(projects.listDeployments(ctx, "project-a")).resolves.toMatchObject({
      data: response,
    });
    expect(listDeployments).toHaveBeenCalledOnce();
  });
  it("lists only the scoped project's deployments through the project-filtered deployment collection", async () => {
    const { auth, ctx } = await setup();
    const list = vi.fn(async () => ({ rows: [], total: 0, page: 1, perPage: 20 }));
    const platform = createPlatform({
      authorization: auth,
      resources: { list } as unknown as DeploymentResourceDependencies,
      recordAudit: vi.fn(),
      trigger: async () => ({ deployment: storedDeployment() }),
      present: (row) => JSON.parse(JSON.stringify(row)),
    });
    await expect(platform.deployments.list(ctx, { projectId: "project-a" })).resolves.toMatchObject(
      { data: { data: [] } },
    );
    expect(list).toHaveBeenCalledOnce();
  });
});

describe("administrative deployment operations", () => {
  it.each(["cancel", "rollback"] as const)(
    "keeps %s out of the trigger capability",
    async (operation) => {
      const state = authorizationFixture();
      state.members.set("org-a:alice", { id: "member-a", role: "owner" });
      state.projects.set("project-a", { organizationId: "org-a" });
      state.deployments.set("dep-project-a", { projectId: "project-a" });
      state.tokenGrants.set("token-a:project:project-a", { permissions: ["deployments:trigger"] });
      const auth = createAuthorization(state);
      const ctx = await auth.resolveScope(
        { ...alice, tokenScope: { tokenId: "token-a" }, credential: { organizationId: "org-a" } },
        "org-a",
      );
      const row = storedDeployment();
      const resources = {
        get: vi.fn(async () => row),
        restorePlan: vi.fn(async () => ({ needsRepository: false })),
        cancel: vi.fn(async () => ({ success: true })),
        rollback: vi.fn(async () => row),
      };
      const platform = createPlatform({
        authorization: auth,
        resources: resources as unknown as DeploymentResourceDependencies,
        recordAudit: vi.fn(),
        trigger: async () => ({ deployment: row }),
        present: (row) => JSON.parse(JSON.stringify(row)),
      });
      await expect(platform.deployments[operation](ctx, "dep-project-a")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(resources[operation]).not.toHaveBeenCalled();
    },
  );
});
