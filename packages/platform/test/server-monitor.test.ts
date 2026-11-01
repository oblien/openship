import { expect, it, vi } from "vitest";
import { createAuthorization } from "../src/authorization";
import { createServerOperations, type ServerDependencies } from "../src/servers";
import { alice, authorizationFixture } from "./fixtures";

it("keeps the default host stream and opts into usage only after server read authorization", async () => {
  const state = authorizationFixture();
  state.members.set("org-a:alice", { id: "member-a", role: "owner" });
  state.servers.set("server-a", { organizationId: "org-a" });
  state.servers.set("server-b", { organizationId: "org-b" });
  const auth = createAuthorization(state);
  const ctx = await auth.resolveScope(alice, "org-a");
  const monitor = vi.fn(async () =>
    (async function* () {
      yield { event: "usage", data: "{}" };
    })(),
  );
  const operations = createServerOperations(auth, {
    collection: {},
    resources: {},
    installations: { monitor },
  } as unknown as ServerDependencies);
  const abort = new AbortController();
  await operations.openMonitor(ctx, "server-a", { signal: abort.signal });
  expect(monitor).toHaveBeenLastCalledWith(expect.anything(), "server-a", abort.signal, undefined);
  const live = await operations.openMonitor(ctx, "server-a", { format: "usage" });
  expect(monitor).toHaveBeenLastCalledWith(expect.anything(), "server-a", undefined, "usage");
  expect((await live.data[Symbol.asyncIterator]().next()).value?.event).toBe("usage");
  await expect(operations.openMonitor(ctx, "server-b", { format: "usage" })).rejects.toThrow();
  expect(monitor).toHaveBeenCalledTimes(2);
  await expect(
    operations.openMonitor(ctx, "server-a", { format: "invalid" as "usage" }),
  ).rejects.toThrow();
  expect(monitor).toHaveBeenCalledTimes(2);
});
