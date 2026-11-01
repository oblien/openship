import { describe, expect, it, vi } from "vitest";
import { createAuthorization } from "../src";
import { createServerOperations, type ServerDependencies } from "../src/servers";
import { alice, authorizationFixture } from "./fixtures";
import { swarmFixture } from "../../contracts/test/swarm-fixture";

it("authorizes server administrators in the selected organization before reading a cluster", async () => {
  const state = authorizationFixture();
  state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
  state.servers.set("server-a", { organizationId: "org-a" });
  state.servers.set("foreign", { organizationId: "org-b" });
  state.grants.set("org-a:alice:server:server-a", { permissions: ["read"] });
  const auth = createAuthorization(state);
  const ctx = await auth.resolveScope(alice, "org-a");
  const inspectSwarm = vi.fn(async () => swarmFixture());
  const servers = createServerOperations(auth, {
    resources: { inspectSwarm },
  } as unknown as ServerDependencies);
  await expect(servers.inspectSwarm(ctx, "server-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(inspectSwarm).not.toHaveBeenCalled();
  state.grants.set("org-a:alice:server:server-a", { permissions: ["admin"] });
  await expect(servers.inspectSwarm(ctx, "foreign")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    servers.inspectSwarm(
      { ...ctx, credential: { organizationId: "org-a", readOnly: true } },
      "server-a",
    ),
  ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
  expect(inspectSwarm).not.toHaveBeenCalled();
  expect((await servers.inspectSwarm(ctx, "server-a", { details: true })).data).toEqual(
    swarmFixture(),
  );
  state.members.clear();
  await expect(servers.inspectSwarm(ctx, "server-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(inspectSwarm).toHaveBeenCalledTimes(1);
});

describe("Swarm contract", () => {
  it("rejects configuration commands and private fields instead of leaking raw Docker responses", async () => {
    const state = authorizationFixture();
    state.members.set("org-a:alice", { id: "member-a", role: "owner" });
    state.servers.set("server-a", { organizationId: "org-a" });
    const auth = createAuthorization(state),
      ctx = await auth.resolveScope(alice, "org-a");
    const inspectSwarm = vi.fn(async () => ({
      ...swarmFixture(),
      JoinTokens: { Worker: "never-return" },
    }));
    const servers = createServerOperations(auth, {
      resources: { inspectSwarm },
    } as unknown as ServerDependencies);
    await expect(
      servers.inspectSwarm(ctx, "server-a", { join: true } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(inspectSwarm).not.toHaveBeenCalled();
    await expect(servers.inspectSwarm(ctx, "server-a")).rejects.toMatchObject({
      code: "INVALID_OPERATION_RESPONSE",
    });
  });
});
