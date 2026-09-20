import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthorization,
  createServiceOperations,
  type ExecutionContext,
  type ServiceDependencies,
} from "../src";
import { alice, authorizationFixture } from "./fixtures";
import { serviceFixture } from "../../contracts/test/fixtures";

let state: ReturnType<typeof authorizationFixture>;
let context: ExecutionContext;
const get = vi.fn(),
  update = vi.fn(),
  create = vi.fn(),
  applyEnvironment = vi.fn(),
  revealEnv = vi.fn(),
  unsubscribe = vi.fn();
let write: (event: string, data: string) => boolean;
let operations: ReturnType<typeof createServiceOperations>;
beforeEach(async () => {
  vi.clearAllMocks();
  state = authorizationFixture();
  state.members.set("org-a:alice", { id: "member-a", role: "owner" });
  state.members.set("org-b:alice", { id: "member-b", role: "owner" });
  state.projects.set("project-a", { organizationId: "org-a" });
  state.projects.set("project-sibling", { organizationId: "org-a" });
  state.projects.set("project-b", { organizationId: "org-b" });
  state.services.set("service-a", { projectId: "project-a" });
  state.services.set("service-b", { projectId: "project-b" });
  const authorization = createAuthorization(state);
  context = await authorization.resolveScope(alice, "org-a");
  operations = createServiceOperations(authorization, {
    collection: { create },
    resources: { get, update, revealEnv, applyEnvironment },
    parentFor: async (_ctx, id) => state.services.get(id)?.projectId,
    subscribe: () => async (fn) => {
      write = fn;
      fn("log", JSON.stringify({ message: "ready" }));
      return { success: true, unsubscribe };
    },
  } as unknown as ServiceDependencies);
  get.mockResolvedValue(serviceFixture());
  update.mockResolvedValue(serviceFixture());
  create.mockResolvedValue(serviceFixture());
  applyEnvironment.mockResolvedValue({ success: true, containerId: "new-container" });
});

describe("shared service authorization", () => {
  it("gates environment apply on the service write grant and its actual parent", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["read"] });
    await expect(operations.applyEnvironment(context, "project-a", "service-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["write"] });
    await expect(operations.applyEnvironment(context, "project-sibling", "service-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(operations.applyEnvironment(context, "project-b", "service-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(applyEnvironment).not.toHaveBeenCalled();
    await expect(operations.applyEnvironment(context, "project-a", "service-a")).resolves.toMatchObject({ data: { success: true, containerId: "new-container" } });
    expect(applyEnvironment).toHaveBeenCalledOnce();
  });
  it("refuses forged same-org parent/child pairs and cross-tenant access", async () => {
    await expect(operations.get(context, "project-sibling", "service-a")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(operations.get(context, "project-b", "service-b")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(get).not.toHaveBeenCalled();
  });
  it("inherits project grants and rechecks their revocation", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["read"] });
    expect((await operations.get(context, "project-a", "service-a")).data.id).toBe("service-a");
    await expect(
      operations.update(context, "project-a", "service-a", { name: "changed" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      operations.revealEnv(context, "project-a", "service-a", { keys: ["TOKEN"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.grants.clear();
    await expect(operations.get(context, "project-a", "service-a")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(get).toHaveBeenCalledOnce();
    expect(revealEnv).not.toHaveBeenCalled();
  });
  it("authorizes collection mutations through the parent project", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["write"] });
    await expect(operations.create(context, "project-a", { name: "web" })).resolves.toMatchObject({
      data: { id: "service-a" },
    });
    await expect(
      operations.create(context, "project-sibling", { name: "web" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(create).toHaveBeenCalledOnce();
  });
  it("validates strict writes and detaches inputs before awaiting authorization", async () => {
    await expect(
      operations.update(context, "project-a", "service-a", { kind: "monorepo" } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const input = { name: "before" };
    const pending = operations.update(context, "project-a", "service-a", input);
    input.name = "after";
    await pending;
    expect(update).toHaveBeenCalledWith(expect.anything(), "project-a", "service-a", {
      name: "before",
    });
    expect(update.mock.calls[0]![0]).not.toHaveProperty("hono");
  });
  it("reauthorizes live events and releases a revoked subscription", async () => {
    const stream = operations.streamLogs(context, "project-a", "service-a")[Symbol.asyncIterator]();
    expect((await stream.next()).value?.event).toBe("log");
    state.members.delete("org-a:alice");
    write("log", JSON.stringify({ message: "must not be disclosed" }));
    await expect(stream.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("releases the subscription after an abort and when a consumer stops early", async () => {
    const abort = new AbortController();
    const stream = operations
      .streamLogs(context, "project-a", "service-a", {}, { signal: abort.signal })
      [Symbol.asyncIterator]();
    await stream.next();
    const pending = stream.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    const next = operations.streamLogs(context, "project-a", "service-a")[Symbol.asyncIterator]();
    await next.next();
    await next.return?.();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
