import "../jobs/_env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { db, schema, repos } from "@repo/db";
import { eq, and } from "drizzle-orm";
import { env, trustedOrigins } from "@repo/platform/engine/config/env";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { seedOwner, seedServer } from "../jobs/_harness";
import { seedProject, seedDeployment, seedService, setActive } from "../../helpers/seed";
import { handleApiError } from "../../../src/middleware/error-handler";
import { consumeServiceTerminalTicket } from "../../../src/lib/service-terminal-session-manager";
import {
  refreshTerminalContext,
  watchTerminalAuthorization,
} from "../../../src/lib/terminal-authorization";
import { authorization } from "@repo/platform/engine/lib/authorization";

const transport = vi.hoisted(() => ({ resolve: vi.fn(), dispose: vi.fn() }));
vi.mock("../../../src/lib/ws", () => ({ upgradeWebSocket: (handler: unknown) => handler }));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: transport.resolve,
  disposeRuntime: transport.dispose,
}));
vi.mock("@repo/platform/engine/modules/services/service-container", () => ({
  containerIdForService: async () => "owned-container",
  liveContainerIdWithRuntime: async () => "owned-container",
}));

const { serviceTerminalRoutes } =
  await import("../../../src/modules/service-terminal/service-terminal.routes");
const { serviceTerminalWsHandler } =
  await import("../../../src/modules/service-terminal/service-terminal.controller");
const { terminalRoutes } = await import("../../../src/modules/terminal/terminal.routes");
const { terminalWsHandler } = await import("../../../src/modules/terminal/terminal.controller");
const app = new Hono();
app.onError(handleApiError);
app.route("/api/services/terminal", serviceTerminalRoutes);
app.route("/api/terminal", terminalRoutes);
const originalCloud = env.CLOUD_MODE;
afterEach(() => {
  env.CLOUD_MODE = originalCloud;
  vi.useRealTimers();
});

beforeEach(() => {
  transport.resolve.mockReset().mockResolvedValue({
    runtime: { name: "docker", supports: () => true, openServiceShell: vi.fn() },
  });
  transport.dispose.mockClear();
});

async function fixture(projectGrant = false) {
  const owner = await seedOwner();
  const project = await seedProject(owner.orgId);
  const deployment = await seedDeployment(project);
  await setActive(project.id, deployment.id);
  const service = await seedService(project.id, { name: "web" });
  const serverId = await seedServer(owner.orgId);
  const minted = mintPatToken();
  const pat = await repos.personalAccessToken.createWithGrants(
    {
      userId: owner.userId,
      organizationId: owner.orgId,
      name: "terminal client",
      tokenPrefix: minted.tokenPrefix,
      tokenHash: minted.tokenHash,
      readOnly: false,
      scoped: true,
      expiresAt: null,
    },
    [
      { resourceType: "terminal", resourceId: "*", permissions: ["write"] },
      ...(projectGrant
        ? [
            {
              resourceType: "project" as const,
              resourceId: project.id,
              permissions: ["admin" as const],
            },
          ]
        : []),
      ...(projectGrant
        ? [
            {
              resourceType: "server" as const,
              resourceId: serverId,
              permissions: ["admin" as const],
            },
          ]
        : []),
    ],
  );
  return { owner, project, service, serverId, pat, token: minted.token };
}

function ticket(token: string, serviceId: string) {
  return app.request("/api/services/terminal/ticket", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ serviceId }),
  });
}

describe.each([false, true])("terminal credential boundaries (Cloud=%s)", (cloud) => {
  beforeEach(() => {
    env.CLOUD_MODE = cloud;
  });
  it("does not inherit the token owner's project administration", async () => {
    const f = await fixture();
    expect((await ticket(f.token, f.service.id)).status).toBe(404);
    expect(transport.resolve).not.toHaveBeenCalled();
  });

  it("allows an explicitly granted project and releases the probe transport", async () => {
    const f = await fixture(true);
    expect((await ticket(f.token, f.service.id)).status).toBe(200);
    expect(transport.resolve).toHaveBeenCalledOnce();
    expect(transport.dispose).toHaveBeenCalledOnce();
  });

  it("does not authorize another tenant even with an explicit project grant", async () => {
    const f = await fixture(true);
    const other = await fixture(true);
    // Even an inconsistent/imported grant cannot cross the token's organization.
    await db.insert(schema.personalAccessTokenGrant).values({
      id: `foreign_${f.pat.id}`,
      tokenId: f.pat.id,
      resourceType: "project",
      resourceId: other.project.id,
      permissionsJson: JSON.stringify(["admin"]),
    });
    expect((await ticket(f.token, other.service.id)).status).toBe(404);
    expect(transport.resolve).not.toHaveBeenCalled();
  });

  it("revalidates an open terminal without checking every keystroke", async () => {
    const f = await fixture(true);
    const response = await ticket(f.token, f.service.id);
    const issued = (await response.json()) as { token: string };
    const context = consumeServiceTerminalTicket(issued.token)!.context;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const denied = vi.fn();
    const stop = watchTerminalAuthorization(
      context,
      { resourceType: "project", resourceId: f.project.id },
      denied,
    );
    try {
      await repos.personalAccessToken.revoke(f.pat.id, f.owner.userId);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(denied).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(15_000);
      expect(denied).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it("stops authorization checks when the socket detaches", async () => {
    const f = await fixture(true);
    const issued = (await (await ticket(f.token, f.service.id)).json()) as { token: string };
    const context = consumeServiceTerminalTicket(issued.token)!.context;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const denied = vi.fn();
    const stop = watchTerminalAuthorization(
      context,
      { resourceType: "project", resourceId: f.project.id },
      denied,
    );
    stop();
    await repos.personalAccessToken.revoke(f.pat.id, f.owner.userId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(denied).not.toHaveBeenCalled();
  });

  it.each(["cookie", "bearer"] as const)(
    "honors revocation and expiry of a %s login session",
    async (sessionKind) => {
      const { owner } = await fixture(true);
      const id = `session_${owner.userId}`;
      await db.insert(schema.session).values({
        id,
        userId: owner.userId,
        token: id,
        activeOrganizationId: owner.orgId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const context = await authorization.resolveScope(
        {
          user: { id: owner.userId, email: `${owner.userId}@test.local`, name: "Owner" },
          sessionId: id,
          sessionKind,
        },
        owner.orgId,
      );
      await expect(refreshTerminalContext(context)).resolves.toMatchObject({
        userId: owner.userId,
      });
      await db
        .update(schema.session)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(schema.session.id, id));
      await expect(refreshTerminalContext(context)).rejects.toMatchObject({ statusCode: 401 });
      await db
        .update(schema.session)
        .set({ expiresAt: new Date(Date.now() + 60_000) })
        .where(eq(schema.session.id, id));
      await repos.session.revokeAllForUser(owner.userId);
      await expect(refreshTerminalContext(context)).rejects.toMatchObject({ statusCode: 401 });
    },
  );

  describe.each(["server", "service"] as const)("%s ticket consumption", (kind) => {
    async function mint(f: Awaited<ReturnType<typeof fixture>>) {
      const response =
        kind === "service"
          ? await ticket(f.token, f.service.id)
          : await app.request("/api/terminal/ticket", {
              method: "POST",
              headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
              body: JSON.stringify({ serverId: f.serverId }),
            });
      expect(response.status).toBe(200);
      return ((await response.json()) as { token: string }).token;
    }

    async function upgrade(token: string, f: Awaited<ReturnType<typeof fixture>>, id?: string) {
      const headers = new Headers({
        origin: trustedOrigins[0]!,
        "sec-websocket-protocol": `openship.terminal.v1+${token}`,
      });
      const factory = (kind === "service"
        ? serviceTerminalWsHandler
        : terminalWsHandler) as unknown as (ctx: unknown) => Promise<{ onOpen: Function }>;
      return factory({
        req: {
          raw: { headers },
          header: (name: string) => headers.get(name),
          param: () => id ?? (kind === "service" ? f.service.id : f.serverId),
        },
        var: { clientIp: null },
      });
    }

    it.each([
      "revoked",
      "expired",
      "read-only",
      "grants-removed",
      "terminal-grant-removed",
      "membership-removed",
    ])("rejects a %s credential before opening a shell", async (change) => {
      const f = await fixture(true);
      const token = await mint(f);
      if (change === "revoked") await repos.personalAccessToken.revoke(f.pat.id, f.owner.userId);
      if (change === "expired")
        await db
          .update(schema.personalAccessToken)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(schema.personalAccessToken.id, f.pat.id));
      if (change === "read-only")
        await db
          .update(schema.personalAccessToken)
          .set({ readOnly: true })
          .where(eq(schema.personalAccessToken.id, f.pat.id));
      if (change === "grants-removed") await repos.patGrant.deleteByToken(f.pat.id);
      if (change === "terminal-grant-removed")
        await db
          .delete(schema.personalAccessTokenGrant)
          .where(
            and(
              eq(schema.personalAccessTokenGrant.tokenId, f.pat.id),
              eq(schema.personalAccessTokenGrant.resourceType, "terminal"),
            ),
          );
      if (change === "membership-removed")
        await db
          .delete(schema.member)
          .where(
            and(
              eq(schema.member.userId, f.owner.userId),
              eq(schema.member.organizationId, f.owner.orgId),
            ),
          );
      transport.resolve.mockClear();
      const handlers = await upgrade(token, f);
      const ws = { send: vi.fn(), close: vi.fn() };
      await handlers.onOpen({}, ws);
      expect(ws.close).toHaveBeenCalledWith(expect.any(Number), expect.any(String));
      expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"error"'));
      expect(transport.resolve).not.toHaveBeenCalled();
    });

    it("allows current grants, binds the target and consumes a ticket only once", async () => {
      const f = await fixture(true);
      const token = await mint(f);
      transport.resolve.mockClear();
      await upgrade(token, f); // Handshake only; never executes a real shell.
      if (kind === "service") expect(transport.resolve).toHaveBeenCalledOnce();
      transport.resolve.mockClear();
      const ws = { send: vi.fn(), close: vi.fn() };
      await (await upgrade(token, f)).onOpen({}, ws);
      expect(ws.close).toHaveBeenCalledWith(4401, expect.any(String));
      expect(transport.resolve).not.toHaveBeenCalled();
      ws.close.mockClear();
      await (await upgrade(await mint(f), f, "different-target")).onOpen({}, ws);
      expect(ws.close).toHaveBeenCalledWith(4401, expect.any(String));
    });
  });
});
