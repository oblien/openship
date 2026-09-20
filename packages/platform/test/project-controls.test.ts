import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectControlSchemas } from "@repo/contracts";
import {
  createAuthorization,
  createProjectOperations,
  type ExecutionContext,
  type ProjectDependencies,
} from "../src";
import { alice, authorizationFixture } from "./fixtures";

let state: ReturnType<typeof authorizationFixture>;
let context: ExecutionContext;
const controls = {
  setBranch: vi.fn(),
  listEnvVars: vi.fn(),
  updateCloneToken: vi.fn(),
  remove: vi.fn(),
  getInfo: vi.fn(),
};
let operations: ReturnType<typeof createProjectOperations>;

beforeEach(async () => {
  vi.clearAllMocks();
  state = authorizationFixture();
  state.members.set("org-a:alice", { id: "member-a", role: "owner" });
  state.members.set("org-b:alice", { id: "member-b", role: "owner" });
  state.projects.set("project-a", { organizationId: "org-a" });
  state.projects.set("project-b", { organizationId: "org-b" });
  const authorization = createAuthorization(state);
  context = await authorization.resolveScope(alice, "org-a");
  operations = createProjectOperations(authorization, {
    controls,
  } as unknown as ProjectDependencies);
});

describe("authorized project controls", () => {
  it("requires administration for removal and rechecks read access on project details", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["write"] });
    await expect(operations.remove(context, "project-a")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(operations.getInfo(context, "project-b")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["admin"] });
    controls.remove.mockResolvedValue({ ok: true, message: "deleted", steps: [] });
    await expect(
      operations.remove(context, "project-a", { recordOnly: true }),
    ).resolves.toMatchObject({ data: { ok: true } });
    state.grants.clear();
    await expect(operations.remove(context, "project-a")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(operations.getInfo(context, "project-a")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(controls.remove).toHaveBeenCalledOnce();
    expect(controls.getInfo).not.toHaveBeenCalled();
  });
  it("refuses cross-tenant reads and writes before reaching a service", async () => {
    await expect(operations.listEnvVars(context, "project-b")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      operations.setBranch(context, "project-b", { branch: "main" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(controls.listEnvVars).not.toHaveBeenCalled();
    expect(controls.setBranch).not.toHaveBeenCalled();
  });

  it("revalidates grants and distinguishes write access from clone-token administration", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["write"] });
    controls.setBranch.mockResolvedValue({ success: true, branch: "release" });
    await expect(
      operations.setBranch(context, "project-a", { branch: "release" }),
    ).resolves.toMatchObject({ data: { branch: "release" } });
    await expect(
      operations.updateCloneToken(context, "project-a", { token: "secret" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.grants.clear();
    await expect(
      operations.setBranch(context, "project-a", { branch: "main" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(controls.setBranch).toHaveBeenCalledTimes(1);
    expect(controls.updateCloneToken).not.toHaveBeenCalled();
  });

  it("rejects invalid inputs and malformed service results instead of promising a false shape", async () => {
    await expect(
      operations.updateCloneToken(context, "project-a", {} as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(controls.updateCloneToken).not.toHaveBeenCalled();
    controls.listEnvVars.mockResolvedValue([{ key: "PARTIAL" }]);
    await expect(operations.listEnvVars(context, "project-a")).rejects.toMatchObject({
      code: "INVALID_OPERATION_RESPONSE",
    });
  });

  it("passes a detached input and the freshly authorized context to retained services", async () => {
    const input = { branch: "release", privateOverride: "discard" };
    controls.setBranch.mockImplementation(async (ctx, id, value) => {
      expect(ctx).not.toHaveProperty("hono");
      expect(ctx.organizationId).toBe("org-a");
      expect(id).toBe("project-a");
      expect(value).toEqual({ branch: "release" });
      expect(value).not.toBe(input);
      return { success: true, branch: value.branch };
    });
    const work = operations.setBranch(context, "project-a", input);
    input.branch = "mutated";
    expect((await work).data.branch).toBe("release");
  });

  it("keeps every declared control behind an authorization boundary when no implementation is configured", async () => {
    const unavailable = createProjectOperations(createAuthorization(state));
    expect(Object.keys(unavailable)).toEqual(
      expect.arrayContaining(Object.keys(ProjectControlSchemas)),
    );
    await expect(unavailable.getResources(context, "project-b")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(unavailable.getResources(context, "project-a")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
  });
});
