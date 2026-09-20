import { beforeEach, describe, expect, it } from "vitest";
import {
  createAuthorization,
  permitsAction,
  type Authorization,
  type ExecutionContext,
} from "../src";
import { alice, authorizationFixture } from "./fixtures";

const writeProject = (id = "project-a") => ({
  resourceType: "project" as const,
  resourceId: id,
  action: "write" as const,
});
let state: ReturnType<typeof authorizationFixture>;
let auth: Authorization;
let context: ExecutionContext;

beforeEach(async () => {
  state = authorizationFixture();
  state.members.set("org-a:alice", { id: "member-a", role: "owner" });
  state.members.set("org-b:alice", { id: "member-b", role: "member" });
  state.projects.set("project-a", { organizationId: "org-a" });
  state.projects.set("project-b", { organizationId: "org-b" });
  auth = createAuthorization(state);
  context = await auth.resolveScope(alice, "org-a");
});

describe("shared authorization", () => {
  it("fails closed for an unknown action supplied by an untyped integration", () => {
    expect(permitsAction(["admin"], "unknown-action" as never)).toBe(false);
  });

  it.each(["owner", "admin", "member", "restricted"])(
    "rejects unknown actions at the authorization boundary for a %s",
    async (role) => {
      state.members.set("org-a:alice", { id: "member-a", role });
      state.grants.set("org-a:alice:project:project-a", { permissions: ["admin"] });
      const input = { ...writeProject(), action: "unknown-action" as never };
      await expect(auth.authorize(context, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await auth.checkPermissionOnResource(context, input)).toBe(false);
      expect(await auth.checkPermission("alice", "org-a", input)).toBe(false);
    },
  );

  it("confines a fixed scope even when the same user belongs to the other organization", async () => {
    await expect(auth.authorize(context, writeProject())).resolves.toMatchObject({
      organizationId: "org-a",
    });
    await expect(auth.authorize(context, writeProject("project-b"))).rejects.toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
    await expect(auth.authorize(context, writeProject("missing"))).rejects.toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
    expect(await auth.checkPermissionOnResource(context, writeProject("project-b"))).toBe(false);
  });

  it("preserves resource-derived HTTP scope and refreshes the role without mutating the original context", async () => {
    const legacy = { ...context, scopeMode: "resource" as const };
    const result = await auth.authorize(legacy, writeProject("project-b"));
    expect(result).toMatchObject({
      organizationId: "org-b",
      role: "member",
      membershipId: "member-b",
    });
    expect(legacy).toMatchObject({
      organizationId: "org-a",
      role: "owner",
      membershipId: "member-a",
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rechecks membership and grants instead of trusting a previously resolved owner role", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    await expect(auth.authorize(context, writeProject())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["write"] });
    await expect(auth.authorize(context, writeProject())).resolves.toMatchObject({
      role: "restricted",
    });
    state.members.delete("org-a:alice");
    await expect(auth.authorize(context, writeProject())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("keeps token grants narrower than an owner's membership and inherited by deployment children", async () => {
    state.deployments.set("deployment-a", { projectId: "project-a" });
    const token = await auth.resolveScope(
      {
        ...alice,
        tokenScope: { tokenId: "token-a" },
        credential: { organizationId: "org-a", readOnly: false },
      },
      "org-a",
    );
    await expect(auth.authorize(token, writeProject())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    state.tokenGrants.set("token-a:project:project-a", { permissions: ["write"] });
    await expect(
      auth.authorize(token, {
        resourceType: "deployment",
        resourceId: "deployment-a",
        action: "write",
      }),
    ).resolves.toMatchObject({ role: "restricted" });
    state.tokenGrants.clear();
    await expect(auth.authorize(token, writeProject())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("pins a bound token's resource resolution even on the legacy HTTP path", async () => {
    const bound = {
      ...context,
      scopeMode: "resource" as const,
      credential: { organizationId: "org-a", readOnly: false },
    };
    await expect(auth.authorize(bound, writeProject("project-b"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      auth.authorize(bound, { resourceType: "settings", resourceId: "*", action: "read" }, "org-b"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps create-only collection access separate from whole-organization reads", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:project:*", { permissions: ["create"] });
    const read = { resourceType: "project" as const, resourceId: "*", action: "read" as const };
    await expect(auth.authorize(context, { ...read, scope: "list" })).resolves.toBeDefined();
    await expect(auth.authorize(context, { ...read, scope: "all" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await auth.checkPermissionOnResource(context, { ...read, scope: "all" })).toBe(false);
    await expect(auth.authorize(context, { ...read, resourceId: "project-a" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.grants.set("org-a:alice:project:*", { permissions: ["read"] });
    await expect(auth.authorize(context, { ...read, scope: "all" })).resolves.toBeDefined();
  });

  it("enforces read-only credentials inside an operation without HTTP middleware", async () => {
    const readonly = { ...context, credential: { organizationId: "org-a", readOnly: true } };
    await expect(auth.authorize(readonly, writeProject())).rejects.toMatchObject({
      code: "TOKEN_READ_ONLY",
      statusCode: 403,
    });
    await expect(
      auth.authorize(readonly, { ...writeProject(), action: "read" }),
    ).resolves.toBeDefined();
    expect(await auth.checkPermissionOnResource(readonly, writeProject())).toBe(false);
  });

  it("rejects expired identities, unbound scoped tokens, and invalid membership roles", async () => {
    await expect(
      auth.resolveScope(
        { ...alice, credential: { organizationId: "org-a", readOnly: false, expiresAt: 0 } },
        "org-a",
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      auth.resolveScope({ ...alice, tokenScope: { tokenId: "unbound" } }, "org-a"),
    ).rejects.toMatchObject({ code: "TOKEN_ORG_UNBOUND" });
    state.members.set("org-a:alice", { id: "member-a", role: "invented-role" });
    await expect(auth.authorize(context, writeProject())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("does not let a scoped token bypass an invalid persisted membership role", async () => {
    const token = await auth.resolveScope(
      {
        ...alice,
        tokenScope: { tokenId: "token-a" },
        credential: { organizationId: "org-a", readOnly: false },
      },
      "org-a",
    );
    state.tokenGrants.set("token-a:project:project-a", { permissions: ["write"] });
    state.members.set("org-a:alice", { id: "member-a", role: "invented-role" });
    await expect(auth.authorize(token, writeProject())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await auth.checkPermissionOnResource(token, writeProject())).toBe(false);
  });

  it("only enables cloud fallback for linked noncanonical instances and directly granted project ids", async () => {
    const cloud = createAuthorization({
      ...state,
      cloud: { isCanonical: () => false, isLinked: async (org) => org === "org-a" },
    });
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:project:upstream-project", { permissions: ["write"] });
    await expect(cloud.authorize(context, writeProject("upstream-project"))).resolves.toMatchObject(
      { organizationId: "org-a" },
    );
    await expect(
      cloud.authorize(context, {
        resourceType: "deployment",
        resourceId: "upstream-child",
        action: "write",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(auth.authorize(context, writeProject("upstream-project"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const canonical = createAuthorization({
      ...state,
      cloud: { isCanonical: () => true, isLinked: async () => true },
    });
    await expect(
      canonical.authorize(context, writeProject("upstream-project")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not share repositories or grants between constructed policy instances", async () => {
    const other = createAuthorization(authorizationFixture());
    await expect(other.authorize(context, writeProject())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(auth.authorize(context, writeProject())).resolves.toBeDefined();
  });
});
