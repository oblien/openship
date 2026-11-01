import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthorization, createPlatform, type VerifiedIdentity } from "@repo/platform";
import type { Deployment } from "@repo/contracts";
import { createShip } from "../src/native";
import { alice, authorizationFixture, storedDeployment } from "../../platform/test/fixtures";

function setup() {
  const state = authorizationFixture();
  for (const suffix of ["a", "b"]) {
    state.members.set(`org-${suffix}:alice`, { id: `member-${suffix}`, role: "owner" });
    state.projects.set(`project-${suffix}`, { organizationId: `org-${suffix}` });
  }
  const trigger = vi.fn(async (ctx, input) => ({
    deployment: storedDeployment(input.projectId, ctx.organizationId),
  }));
  const audit = vi.fn();
  const forward = vi.fn(async () => null);
  const platform = createPlatform({
    authorization: createAuthorization(state),
    trigger,
    present: (row) => JSON.parse(JSON.stringify(row)) as Deployment,
    recordAudit: audit,
    forward,
  });
  const resolve = vi.fn(
    async (assertion: string): Promise<VerifiedIdentity | null> =>
      assertion === "verified" ? alice : null,
  );
  return {
    state,
    trigger,
    audit,
    forward,
    resolve,
    platform,
    ship: createShip({ platform, identity: { resolve } }),
  };
}

let env: ReturnType<typeof setup>;
beforeEach(() => {
  env = setup();
});

describe("native SDK", () => {
  it("snapshots trusted caller attribution without changing authorization", async () => {
    const caller = { source: "cli" as "cli" | "api", userAgent: "openship-cli/test" };
    const ship = createShip({ platform: env.platform, identity: { resolve: env.resolve }, caller });
    caller.source = "api";
    caller.userAgent = "mutated";
    const scope = await ship.scope({ identity: "verified", organizationId: "org-a" });
    await scope.deployments.create({ projectId: "project-a" });
    expect(env.trigger.mock.calls[0]![0]).toMatchObject({ source: "cli", userAgent: "openship-cli/test", sessionKind: "native", role: "owner" });
    expect(env.audit.mock.calls[0]![0]).toBe(env.trigger.mock.calls[0]![0]);
  });

  it.each([null, "cli", { source: "root" }, { userAgent: 42 }, { userAgent: "x".repeat(1025) }])(
    "rejects invalid attribution before allocating an owned instance: %j", caller => {
      expect(() => createShip({ identity: { resolve: env.resolve }, caller } as never)).toThrow("Invalid SDK caller");
    },
  );

  it("invokes the shared deployment operation directly with a verified, Hono-free context", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected HTTP request"));
    try {
      const scoped = await env.ship.scope({ identity: "verified", organizationId: "org-a" });
      const result = await scoped.deployments.create({
        projectId: "project-a",
        serverId: "server-a",
        smartRoute: true,
      });
      expect(result).toMatchObject({ deployment_id: "dep-project-a", project_id: "project-a" });
      const [ctx, input] = env.trigger.mock.calls[0]!;
      expect(ctx).toMatchObject({
        userId: "alice",
        organizationId: "org-a",
        role: "owner",
        sessionKind: "native",
      });
      expect(ctx).not.toHaveProperty("hono");
      expect(Object.isFrozen(ctx)).toBe(true);
      expect(input).toMatchObject({
        projectId: "project-a",
        serverId: "server-a",
        smartRoute: true,
      });
      expect(env.audit).toHaveBeenCalledOnce();
      expect(env.audit.mock.calls[0]![0]).toBe(ctx);
      expect(result.deployment?.createdAt).toBe("2026-09-11T00:00:00.000Z");
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });

  it("requires the installed identity adapter and rejects a caller-selected user or role", async () => {
    await expect(
      env.ship.scope({ identity: "alice", organizationId: "org-a" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    env.state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    const scoped = await env.ship.scope({
      identity: "verified",
      organizationId: "org-a",
      role: "owner",
      userId: "root",
    } as never);
    await expect(scoped.deployments.create({ projectId: "project-a" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(env.trigger).not.toHaveBeenCalled();
    expect(env.audit).not.toHaveBeenCalled();
  });

  it("keeps concurrent tenant views isolated, including when the actor belongs to both", async () => {
    const [a, b] = await Promise.all([
      env.ship.scope({ identity: "verified", organizationId: "org-a" }),
      env.ship.scope({ identity: "verified", organizationId: "org-b" }),
    ]);
    const results = await Promise.all([
      a.deployments.create({ projectId: "project-a" }),
      b.deployments.create({ projectId: "project-b" }),
    ]);
    expect(results.map((r) => r.deployment?.organizationId)).toEqual(["org-a", "org-b"]);
    expect(new Set(env.trigger.mock.calls.map(([ctx]) => ctx.traceId)).size).toBe(2);
    await expect(a.deployments.create({ projectId: "project-b" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(env.trigger).toHaveBeenCalledTimes(2);
  });

  it("revalidates credentials and membership when an existing scope is used", async () => {
    const scoped = await env.ship.scope({ identity: "verified", organizationId: "org-a" });
    env.resolve.mockResolvedValueOnce(null);
    await expect(scoped.deployments.create({ projectId: "project-a" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    env.state.members.delete("org-a:alice");
    await expect(scoped.deployments.create({ projectId: "project-a" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(env.trigger).not.toHaveBeenCalled();
  });

  it("does not let a scope silently change actors when its assertion is refreshed", async () => {
    const scoped = await env.ship.scope({ identity: "verified", organizationId: "org-a" });
    env.resolve.mockResolvedValue({ ...alice, user: { ...alice.user, id: "another-user" } });
    await expect(scoped.deployments.create({ projectId: "project-a" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(env.trigger).not.toHaveBeenCalled();
  });

  it("applies newly read-only credentials before orchestration or audit", async () => {
    const scoped = await env.ship.scope({ identity: "verified", organizationId: "org-a" });
    env.resolve.mockResolvedValue({
      ...alice,
      credential: { organizationId: "org-a", readOnly: true },
    });
    await expect(scoped.deployments.create({ projectId: "project-a" })).rejects.toMatchObject({
      code: "TOKEN_READ_ONLY",
    });
    expect(env.trigger).not.toHaveBeenCalled();
    expect(env.audit).not.toHaveBeenCalled();
  });

  it("snapshots inputs before authentication and drops private pipeline controls", async () => {
    const scoped = await env.ship.scope({ identity: "verified", organizationId: "org-a" });
    let release!: (identity: VerifiedIdentity) => void;
    env.resolve.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const input = {
      projectId: "project-a",
      serviceIds: ["service-a"],
      reuseSnapshot: { meta: "unsafe" },
      trigger: "rollback",
    };
    const pending = scoped.deployments.create(input);
    input.projectId = "project-b";
    input.serviceIds.push("service-b");
    release(alice);
    await pending;
    const actual = env.trigger.mock.calls[0]![1];
    expect(actual).toMatchObject({ projectId: "project-a", serviceIds: ["service-a"] });
    expect(actual).not.toHaveProperty("reuseSnapshot");
    expect(actual.trigger).toBeUndefined();
  });

  it.each([
    {},
    null,
    { projectId: "" },
    { projectId: "project-a", forceAll: "true" },
    { projectId: "project-a", serviceIds: [1] },
    { projectId: "project-a", environment: "invalid" },
  ])("validates public inputs before invoking the engine: %j", async (input) => {
    const scoped = await env.ship.scope({ identity: "verified", organizationId: "org-a" });
    await expect(scoped.deployments.create(input as never)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(env.trigger).not.toHaveBeenCalled();
    expect(env.audit).not.toHaveBeenCalled();
  });
});
