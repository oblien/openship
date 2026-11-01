import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthorization,
  createProjectOperations,
  type ProjectDependencies,
  type ExecutionContext,
} from "../src";
import { alice, authorizationFixture } from "./fixtures";

let state: ReturnType<typeof authorizationFixture>;
let context: ExecutionContext;
let operations: ReturnType<typeof createProjectOperations>;
let write: (event: string, data: string) => boolean;
const unsubscribe = vi.fn();
const subscribe = vi.fn(() => (emit: typeof write) => {
  write = emit;
  emit("session", JSON.stringify({ type: "session" }));
  return { success: true, unsubscribe };
});

beforeEach(async () => {
  vi.clearAllMocks();
  state = authorizationFixture();
  state.members.set("org-a:alice", { id: "a", role: "owner" });
  state.projects.set("project-a", { organizationId: "org-a" });
  state.projects.set("project-b", { organizationId: "org-b" });
  const auth = createAuthorization(state);
  context = await auth.resolveScope(alice, "org-a");
  operations = createProjectOperations(auth, {
    subscribeRoutingRetry: subscribe,
  } as unknown as ProjectDependencies);
});

describe("routing retry stream", () => {
  it("delivers logs and the terminal result without keeping the stream open", async () => {
    const iterator = operations.retryRoutingStream(context, "project-a")[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toBe("session");
    write("log", JSON.stringify({ type: "log", message: "api.example.com: certificate reused" }));
    write("complete", JSON.stringify({ type: "complete", status: "completed" }));
    expect((await iterator.next()).value?.data).toContain("certificate reused");
    expect((await iterator.next()).value?.event).toBe("complete");
    expect((await iterator.next()).done).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("requires write access before starting any repair", async () => {
    state.members.set("org-a:alice", { id: "a", role: "restricted" });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["read"] });
    for (const id of ["project-a", "project-b"]) {
      await expect(
        operations.retryRoutingStream(context, id)[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("allows a project reader to reattach but never upgrades a read into a new repair", async () => {
    state.members.set("org-a:alice", { id: "a", role: "restricted" });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["read"] });
    const iterator = operations
      .retryRoutingStream(context, "project-a", { sessionId: "routing-a" })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toBe("session");
    expect(subscribe).toHaveBeenCalledWith(
      expect.any(Object),
      "project-a",
      expect.objectContaining({ sessionId: "routing-a" }),
    );
    await iterator.return?.();
    await expect(
      operations.retryRoutingStream(context, "project-a")[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      operations
        .retryRoutingStream(context, "project-b", { sessionId: "routing-a" })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("stops disclosing logs when access is revoked", async () => {
    const iterator = operations.retryRoutingStream(context, "project-a")[Symbol.asyncIterator]();
    await iterator.next();
    state.members.delete("org-a:alice");
    write("log", "private route details");
    await expect(iterator.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("cancels a waiting viewer and releases the subscriber", async () => {
    const abort = new AbortController();
    const iterator = operations
      .retryRoutingStream(context, "project-a", { signal: abort.signal })
      [Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
