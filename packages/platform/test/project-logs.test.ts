import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthorization,
  createProjectOperations,
  type ProjectDependencies,
  type ExecutionContext,
} from "../src";
import { alice, authorizationFixture } from "./fixtures";
import { projectFixture } from "../../contracts/test/fixtures";

let state: ReturnType<typeof authorizationFixture>;
let context: ExecutionContext;
let operations: ReturnType<typeof createProjectOperations>;
const unsubscribe = vi.fn();
const finished = vi.fn();
const home = vi.fn();
const list = vi.fn();
const get = vi.fn();
const open = vi.fn(async () =>
  (async function* () {
    try {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
    } finally {
      finished();
    }
  })(),
);
const subscribe = vi.fn(() => (write: (event: string, data: string) => boolean) => {
  write("log", "first");
  write("log", "second");
  return { success: true, unsubscribe };
});

beforeEach(async () => {
  vi.clearAllMocks();
  state = authorizationFixture();
  state.members.set("org-a:alice", { id: "a", role: "owner" });
  state.members.set("org-b:alice", { id: "b", role: "owner" });
  state.projects.set("project-a", { organizationId: "org-a" });
  state.projects.set("project-b", { organizationId: "org-b" });
  const auth = createAuthorization(state);
  context = await auth.resolveScope(alice, "org-a");
  operations = createProjectOperations(auth, {
    home,
    list,
    get,
    openServerLogs: open,
    subscribeLogs: subscribe,
  } as unknown as ProjectDependencies);
});

describe("project overview and streams", () => {
  it("omits project credentials from list and detail read projections", async () => {
    const stored = {
      ...projectFixture(),
      cloneTokenEncrypted: "encrypted-clone-value",
      webhookSecret: "reusable-webhook-value",
    };
    list.mockResolvedValue({ rows: [stored], total: 1, page: 1, perPage: 20 });
    get.mockResolvedValue(stored);

    const page = (await operations.list(context)).data;
    const detail = (await operations.get(context, "project-a")).data;
    for (const project of [page.data[0], detail]) {
      expect(project).not.toHaveProperty("cloneTokenEncrypted");
      expect(project).not.toHaveProperty("webhookSecret");
      expect(JSON.stringify(project)).not.toContain("reusable-webhook-value");
    }
    expect(stored.webhookSecret).toBe("reusable-webhook-value");
  });

  it("refreshes membership for home and strips secret fields from custom compositions", async () => {
    home.mockResolvedValue({
      success: true,
      projects: [{ ...projectFixture(), cloneTokenEncrypted: "cipher", webhookSecret: "secret" }],
      numbers: {
        total_projects: 1,
        total_active_projects: 1,
        total_deployments: 0,
        total_success_deployments: 0,
      },
      otherOrgs: [],
    });
    const result = await operations.getHome(context);
    expect(result.data.projects[0]).not.toHaveProperty("cloneTokenEncrypted");
    expect(result.data.projects[0]).not.toHaveProperty("webhookSecret");
    state.members.delete("org-a:alice");
    await expect(operations.getHome(context)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(home).toHaveBeenCalledOnce();
  });
  it("refuses a foreign project before opening either source", async () => {
    await expect(operations.openServerLogStream(context, "project-b")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      operations.streamRuntimeLogs(context, "project-b")[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(open).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
  it("rechecks runtime log access between events and unsubscribes on revocation", async () => {
    const iterator = operations.streamRuntimeLogs(context, "project-a")[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ event: "log", data: "first" });
    state.members.delete("org-a:alice");
    await expect(iterator.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("rechecks byte-stream access between chunks and closes the provider on revocation", async () => {
    const { data } = await operations.openServerLogStream(context, "project-a");
    const iterator = data[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(new Uint8Array([1, 2]));
    state.members.delete("org-a:alice");
    await expect(iterator.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(finished).toHaveBeenCalledOnce();
  });
  it("cancels a waiting runtime stream and rejects invalid inputs before subscribing", async () => {
    subscribe.mockImplementationOnce(() => () => ({ success: true, unsubscribe }));
    const abort = new AbortController();
    const iterator = operations
      .streamRuntimeLogs(context, "project-a", {}, { signal: abort.signal })
      [Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    abort.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    await expect(
      operations
        .streamRuntimeLogs(context, "project-a", { tail: -2 })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
