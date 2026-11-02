import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
const fixture = vi.hoisted(() => {
  process.env.DEPLOY_MODE = "desktop";
  process.env.OPENSHIP_AUTH_MODE = "local";
  process.env.OPENSHIP_LOCAL_DASHBOARD_URL = "http://localhost:3001";
  process.env.OPENSHIP_RATE_LIMIT_STORE = "memory";
  process.env.BETTER_AUTH_SECRET = "chat-integration-test-secret-0123456789";
  return {
    forward: vi.fn(),
    factory: vi.fn(),
    runs: [] as any[],
    script: undefined as undefined | ((run: any, options: any) => AsyncGenerator<any>),
  };
});
vi.mock("../../../src/app", () => ({ app: { fetch: fixture.forward } }));
vi.mock("../../../src/modules/assistant/assistant.service", async (original) => {
  const module =
    await original<typeof import("../../../src/modules/assistant/assistant.service")>();
  return { ...module, assistant: module.createAssistantRuntime(fixture.factory) };
});
import { db, repos, schema, eq } from "@repo/db";
import { seedOrg, seedProject, seedDeployment, setActive } from "../../helpers/seed";
import { env } from "@repo/platform/engine/config/env";
import { fail } from "../../../src/modules/chat-apps/chat-apps-common";
import { createDirectChatTransport } from "../../../src/modules/chat-apps/transport/direct";
import type { ChatTransport } from "../../../src/modules/chat-apps/transport/types";
import { auth } from "@repo/platform/engine/lib/auth";
import * as buildService from "@repo/platform/engine/modules/deployments/build.service";
import * as deploymentService from "@repo/platform/engine/modules/deployments/deployment.service";
import { authRoutes } from "../../../src/modules/auth/auth.routes";
import { settingsRoutes } from "../../../src/modules/settings/settings.routes";
import { tokenRoutes } from "../../../src/modules/tokens/token.routes";
import { chatAppRoutes } from "../../../src/modules/chat-apps/chat-apps.routes";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { deploymentRoutes } from "../../../src/modules/deployments/deployment.routes";
import { forceMcpConsent } from "../../../src/middleware/mcp-consent";
import { clientIpMiddleware } from "../../../src/middleware/client-ip";
import { handleApiError } from "../../../src/middleware/error-handler";
import { scanRoutes } from "../../../src/lib/route-scanner";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";
import { resetMcpToolCache } from "../../../src/modules/mcp/mcp-tools";
import {
  COMMAND_HELP,
  createChatCommands as createStructuredCommands,
  parseChatCommand,
} from "../../../src/modules/chat-apps/chat-apps-commands";
import { fingerprint, senderKey } from "../../../src/modules/chat-apps/chat-apps-common";
import type { HostEvent } from "../../../src/modules/chat-apps/transport/types";
import {
  assistant,
  createAssistantRuntime,
} from "../../../src/modules/assistant/assistant.service";
import { assistantRoutes } from "../../../src/modules/assistant/assistant.routes";
import { createChatAssistant } from "../../../src/modules/chat-apps/chat-assistant";
import { createChatApps } from "../../../src/modules/chat-apps/chat-apps.service";
import { resolveExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import { mcpRoutes } from "../../../src/modules/mcp/mcp.routes";
import { permissionsRoutes } from "../../../src/modules/permissions/permissions.routes";
import { getMcpTools } from "../../../src/modules/mcp/mcp-tools";
import { appendAssistantEvents, chatNativeCommands, chatSlackCommands } from "@repo/contracts";
const origin = "http://localhost:4000";
const app = new Hono()
  .onError(handleApiError)
  .use("*", clientIpMiddleware)
  .use("/api/auth/mcp/authorize", forceMcpConsent)
  .route("/api/auth", authRoutes)
  .route("/api/settings", settingsRoutes)
  .route("/api/tokens", tokenRoutes)
  .route("/api/chat-apps", chatAppRoutes)
  .route("/api/assistant", assistantRoutes)
  .route("/api/mcp", mcpRoutes)
  .route("/api/permissions", permissionsRoutes)
  .route("/api/projects", projectRoutes)
  .route("/api/deployments", deploymentRoutes);
beforeAll(() => {
  fixture.forward.mockImplementation((r: Request) => app.fetch(r));
  resetMcpToolCache();
  fixture.factory.mockImplementation(async () => ({
    healthy: () => true,
    close: async () => {},
    workspace: async () => "/tmp/chat-assistant-test-no-exec",
    probe: async () => ({ available: true, version: "fixture" }),
    mindwire: {
      withAgent() {
        return this;
      },
      agent: async () => ({
        schema: { sections: [] },
        authStatus: { configured: true },
        authMethods: [],
      }),
      getConfig: async () => ({}),
      models: async () => [],
      messagePage: async () => ({ messages: [], hasMore: false }),
      deleteChat: async () => {},
      run: async (id: string) => fixture.runs.find((r) => r.id === id),
      turn: async (options: any) => {
        const run: any = {
          id: randomUUID(),
          chatId: options.chatId,
          status: "running",
          options,
          cancelled: false,
          messages: [],
          createdAt: new Date().toISOString(),
        };
        run.snapshot = async () => ({
          run: { id: run.id, chatId: run.chatId, status: run.status, createdAt: run.createdAt },
          parts: run.messages.flatMap((m: any) => m.parts ?? []),
          sequence: 0,
        });
        run.refresh = async () => run;
        run.cancel = async () => {
          run.cancelled = true;
          run.status = "cancelled";
          run.release?.();
        };
        run.sendInput = vi.fn(async () => {
          run.release?.();
        });
        run.respond = vi.fn(async () => {
          run.release?.();
        });
        const script = fixture.script;
        async function* response() {
          if (script) yield* script(run, options);
          else yield { type: "text", text: `Reply to: ${options.message}` };
        }
        run.stream = async function* () {
          for await (const native of response()) {
            run.messages = appendAssistantEvents(run.messages, [{ sequence: 1, native }], run.id);
            yield native;
          }
          if (!run.cancelled) run.status = "done";
        };
        fixture.runs.push(run);
        return run;
      },
    },
  }));
});
afterAll(async () => {
  await assistant.close();
  await shutdownRateLimit();
});
import { chatReply } from "../../../src/modules/chat-apps/chat-reply";
function createChatCommands(...args: Parameters<typeof createStructuredCommands>) {
  const commands = createStructuredCommands(...args);
  return {
    async handle(...input: Parameters<typeof commands.handle>) {
      const reply = await commands.handle(...input);
      return reply === null ? null : reply.messages.map((m) => m.text).join("\n");
    },
  };
}
const commands = createChatCommands();
async function actor() {
  const owner = await seedOrg(),
    token = randomUUID();
  await db.insert(schema.session).values({
    id: randomUUID(),
    token,
    userId: owner.userId,
    activeOrganizationId: owner.organizationId,
    expiresAt: new Date(Date.now() + 3600000),
  });
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET).update(token).digest("base64");
  return {
    ...owner,
    cookie: `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}
type Actor = Awaited<ReturnType<typeof actor>>;
const request = (a: Actor, method: string, path: string, body?: unknown) =>
  app.request(new URL(path, origin), {
    method,
    headers: { cookie: a.cookie, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
async function data(a: Actor, path: string, body: unknown) {
  const r = await request(a, "POST", path, body);
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()).data;
}
function event(text: string, over: Partial<HostEvent> = {}): HostEvent {
  return {
    id: randomUUID(),
    integrationId: "native",
    workspaceId: "team",
    channelId: "channel",
    userId: "sender",
    text,
    lease: "lease",
    revision: 1,
    command: true,
    ...over,
  };
}
async function connection(a: Actor) {
  return repos.chatApps.create({
    id: randomUUID(),
    ...a,
    name: "Testing",
    provider: "slack",
    purpose: "both",
    origin,
    enabled: true,
    nativeId: "native",
  });
}
async function authorize(
  a: Actor,
  c: Awaited<ReturnType<typeof connection>>,
  readOnly = false,
  sender: Partial<HostEvent> = {},
) {
  const link = await commands.handle(c, event("link", sender));
  const url = link.match(/http:\/\/localhost:3001\/settings\?[^\s]+/)![0];
  expect(link).toContain("Open the link in the next message");
  const challenge = new URL(url).searchParams.get("link")!;
  const prepared = await data(a, "/api/chat-apps/pairing", { challenge });
  const grant = await request(a, "POST", "/api/tokens/mcp-authorize", {
    clientId: prepared.clientId,
    organizationId: a.organizationId,
    fullAccess: true,
    readOnly,
    grants: [],
  });
  expect(grant.status, await grant.clone().text()).toBe(200);
  const accepted = await request(a, "POST", "/api/auth/oauth2/consent", {
    accept: true,
    consent_code: prepared.consentCode,
  });
  expect(accepted.status).toBe(200);
  const callback = new URL((await accepted.json()).redirectURI);
  const verified = await data(a, "/api/chat-apps/pairing/complete", {
    state: prepared.state,
    code: callback.searchParams.get("code"),
  });
  return { ...verified, clientId: prepared.clientId, challenge };
}
async function linked(readOnly = false) {
  const owner = await actor(),
    c = await connection(owner),
    p = await authorize(owner, c, readOnly);
  expect(await commands.handle(c, event(`verify ${p.verification}`))).toContain("connected");
  return { owner, c, ...p };
}
describe("Chat commands through normal OAuth and deployment routes", () => {
  it("saves language only for the authenticated user and preserves other preferences", async () => {
    const owner = await actor(),
      other = await actor();
    await repos.settings.setCloudSession(owner.userId, "encrypted-fixture");
    const updated = await request(owner, "PATCH", "/api/settings/locale", {
      locale: "ar",
      userId: other.userId,
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await repos.settings.findByUser(owner.userId)).toMatchObject({
      locale: "ar",
      cloudSessionToken: "encrypted-fixture",
    });
    expect((await repos.settings.findByUser(other.userId))?.locale).toBeUndefined();
    expect(
      (await request(owner, "PATCH", "/api/settings/locale", { locale: "not-a-locale" })).status,
    ).toBe(400);
    const anonymous = await app.request(`${origin}/api/settings/locale`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: "fr" }),
    });
    expect(anonymous.status).toBe(401);
  });
  it("uses each linked user's language instead of the installer's language", async () => {
    const { owner, c } = await linked();
    const installer = await actor();
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: owner.organizationId,
      userId: installer.userId,
      role: "admin",
    });
    await db
      .update(schema.chatAppConnection)
      .set({ userId: installer.userId })
      .where(eq(schema.chatAppConnection.id, c.id));
    const connection = (await repos.chatApps.get(c.id))!;
    await repos.settings.setLocale(installer.userId, "ar");
    await repos.settings.setLocale(owner.userId, "fr");
    expect(await commands.handle(connection, event("help"))).toContain("Commandes OpenShip");
    expect(await commands.handle(connection, event("help", { userId: "unlinked" }))).toContain(
      "أوامر OpenShip",
    );
    await repos.settings.setLocale(owner.userId, "de");
    expect(await commands.handle(connection, event("help"))).toContain("OpenShip-Befehle");
  });

  it("passes the same route security scan enforced at application startup", () => {
    const result = scanRoutes(app);
    expect(result.errors.filter((entry) => entry.route.path.startsWith("/api/chat-apps"))).toEqual(
      [],
    );
  });
  it("parses a finite command vocabulary and rejects argument injection", () => {
    expect(parseChatCommand("/openship@my_bot status abc")).toEqual({ verb: "status", arg: "abc" });
    for (const verb of ["help", "link", "unlink", "projects"]) {
      expect(parseChatCommand(`/openship ${verb}`)).toEqual({ verb, arg: undefined });
      expect(parseChatCommand(`/openship ${verb} unexpected`).verb).toBe("help");
    }
    for (const verb of ["status", "logs", "redeploy", "restart", "verify", "confirm"]) {
      expect(parseChatCommand(`/openship ${verb} test_123-abc`)).toEqual({
        verb,
        arg: "test_123-abc",
      });
      expect(parseChatCommand(`/openship ${verb}`).verb).toBe(
        ["verify", "confirm"].includes(verb) ? "help" : verb,
      );
    }
    for (const input of [
      "restart abc ; whoami",
      "logs ../../secret",
      "confirm a extra",
      "DELETE /api/projects/x",
      "constructor x",
      `verify ${"a".repeat(129)}`,
    ]) {
      expect(parseChatCommand(input).verb).toBe("help");
    }
  });
  it("shows every command, including how to finish linking and confirm an action", async () => {
    const owner = await actor(),
      c = await connection(owner);
    const help = await commands.handle(c, event("/openship help"));
    expect(help).toBe(COMMAND_HELP);
    for (const verb of [
      "help",
      "link",
      "verify",
      "unlink",
      "projects",
      "status",
      "logs",
      "redeploy",
      "restart",
      "confirm",
    ]) {
      expect(help).toContain(`/openship ${verb}`);
    }
    expect(help).toContain("/openship confirm");
    // Discord is the smallest message budget. Keep the full reference in one reply.
    expect(help.length).toBeLessThanOrEqual(1900);
  });
  it("does not share installer access; binds browser consent to the original sender", async () => {
    const owner = await actor(),
      c = await connection(owner);
    expect(await commands.handle(c, event("projects"))).toContain("Connect your own");
    const p = await authorize(owner, c);
    expect(await repos.chatApps.identity(c.id, "team", "sender")).toBeUndefined();
    expect(
      await commands.handle(c, event(`verify ${p.verification}`, { userId: "imposter" })),
    ).toContain("same chat account");
    expect(await commands.handle(c, event(`verify ${p.verification}`))).toContain("connected");
    expect(await commands.handle(c, event(`verify ${p.verification}`))).toContain("expired");
    expect(await commands.handle(c, event("projects", { userId: "imposter" }))).toContain(
      "Connect your own",
    );
    const outsider = await actor();
    expect(
      (await request(outsider, "POST", "/api/chat-apps/pairing", { challenge: p.challenge }))
        .status,
    ).toBe(404);
  });
  it("uses scoped project data and does not disclose another workspace", async () => {
    const { owner, c } = await linked();
    const project = await seedProject(owner.organizationId, { name: "Chat app" });
    const other = await actor(),
      foreign = await seedProject(other.organizationId, { name: "Private other customer" });
    const listing = await commands.handle(c, event("projects"));
    expect(listing).toContain("Chat app");
    expect(listing).toContain(project.id);
    const dep = await seedDeployment(project);
    await setActive(project.id, dep.id);
    expect(await commands.handle(c, event(`status ${project.id}`))).toContain("ready");
    expect(listing).not.toContain(foreign.name);
    expect(listing).not.toContain(foreign.id);
    for (const verb of ["status", "logs", "restart", "redeploy"]) {
      const result = await commands.handle(c, event(`${verb} ${foreign.id}`));
      expect(result).not.toContain(foreign.name);
      expect(result).not.toContain("/openship confirm");
      expect(result).toMatch(/not found|access/i);
    }
    expect(await commands.handle(c, event(`logs ${project.id}`))).toContain(
      `/projects/${project.id}/logs`,
    );
  });
  it("requires sender-bound confirmation and dispatches a duplicate redeploy only once", async () => {
    const { owner, c } = await linked();
    const project = await seedProject(owner.organizationId, { name: "Production" });
    const dep = await seedDeployment(project);
    await setActive(project.id, dep.id);
    const spy = vi
      .spyOn(buildService, "redeployBuildSession")
      .mockImplementation(async (_ctx, id) => ({ deployment_id: id }) as any);
    try {
      const prompt = await commands.handle(c, event(`redeploy ${project.id}`));
      expect(prompt).toContain("Confirm within");
      expect(spy).not.toHaveBeenCalled();
      const confirm = prompt.match(/\/openship confirm ([\w-]+)/)![1];
      expect(
        await commands.handle(c, event(`confirm ${confirm}`, { channelId: "elsewhere" })),
      ).toContain("same account");
      const msg = event(`confirm ${confirm}`);
      const replies = await Promise.all([
        commands.handle(c, msg),
        commands.handle(c, msg),
        commands.handle(c, event(`confirm ${confirm}`)),
      ]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(replies.join(" ")).toContain("Redeployment requested");
      expect(spy.mock.calls[0]![0]).toMatchObject({
        userId: owner.userId,
        organizationId: owner.organizationId,
      });
      expect(spy.mock.calls[0]![1]).toBe(dep.id);
      expect(spy.mock.calls[0]![0]).toMatchObject({
        source: "webhook",
        sourceClientId: expect.stringMatching(/^oauth:/),
      });
      await commands.handle(c, msg);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await commands.handle(c, { ...msg, userId: "imposter" })).toContain("changed");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("rechecks read-only grants and a changed active deployment at confirmation time", async () => {
    const { owner, c } = await linked(true);
    const project = await seedProject(owner.organizationId),
      dep = await seedDeployment(project);
    await setActive(project.id, dep.id);
    const spy = vi.spyOn(deploymentService, "restartDeployment");
    try {
      const prompt = await commands.handle(c, event(`restart ${project.id}`));
      const confirm = prompt.match(/\/openship confirm ([\w-]+)/)![1];
      expect(await commands.handle(c, event(`confirm ${confirm}`))).toContain("approved access");
      expect(spy).not.toHaveBeenCalled();
      const next = await commands.handle(c, event(`restart ${project.id}`));
      const nextConfirm = next.match(/\/openship confirm ([\w-]+)/)![1];
      const newDep = await seedDeployment(project);
      await setActive(project.id, newDep.id);
      expect(await commands.handle(c, event(`confirm ${nextConfirm}`))).toContain(
        "deployment changed",
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it("refuses revoked credentials and leaves interrupted commands un-replayed", async () => {
    const { owner, c, clientId } = await linked();
    const msg = event("projects");
    await repos.chatApps.claimCommand({
      id: fingerprint([c.id, msg.id]),
      connectionId: c.id,
      externalUser: msg.userId,
      requestFingerprint: fingerprint([
        c.revision,
        msg.integrationId,
        senderKey(msg),
        msg.text,
        msg.command,
      ]),
      identityId: (await repos.chatApps.identity(c.id, msg.workspaceId, msg.userId))!.id,
      command: "projects",
    });
    expect(await commands.handle(c, msg)).toContain("will not be replayed");
    await repos.oauth.disconnectMcpClient(owner.userId, clientId);
    expect(await commands.handle(c, event("projects"))).toContain("disconnected");
    expect(await commands.handle(c, event("unlink"))).toContain("disconnected");
    expect(await repos.chatApps.identity(c.id, "team", "sender")).toBeUndefined();
    await repos.chatApps.update(c.id, c.revision, { enabled: false });
    await expect(commands.handle(c, event("help"))).rejects.toThrow("disabled or changed");
  });
  it("exposes only read-only connector discovery as MCP tools and never accepts bearer setup", async () => {
    const { getMcpTools } = await import("../../../src/modules/mcp/mcp-tools");
    expect(getMcpTools().filter((t) => t.path.includes("chat-apps")).map((t) => `${t.method} ${t.path}`).sort()).toEqual(["GET /api/chat-apps/", "GET /api/chat-apps/setup"]);
    const { owner, c, clientId } = await linked();
    const token = await repos.oauth.findClientToken(owner.userId, clientId);
    const r = await app.request(`${origin}/api/chat-apps/${c.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token!.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, revision: c.revision }),
    });
    expect(r.status).toBe(403);
    const outsider = await actor();
    expect(
      (
        await request(outsider, "PATCH", `/api/chat-apps/${c.id}`, {
          enabled: false,
          revision: c.revision,
        })
      ).status,
    ).toBe(404);
  });
  it("blocks cached reads and pending writes after workspace membership is removed", async () => {
    const { owner, c } = await linked();
    const project = await seedProject(owner.organizationId, { name: "Member private project" });
    const dep = await seedDeployment(project);
    await setActive(project.id, dep.id);
    const listingEvent = event("projects");
    expect(await commands.handle(c, listingEvent)).toContain(project.name);
    const prompt = await commands.handle(c, event(`redeploy ${project.id}`));
    const confirmation = prompt.match(/\/openship confirm ([\w-]+)/)![1];
    const member = (await repos.member.find(owner.organizationId, owner.userId))!;
    await db.delete(schema.member).where(eq(schema.member.id, member.id));
    const spy = vi.spyOn(buildService, "redeployBuildSession");
    try {
      expect(await commands.handle(c, listingEvent)).not.toContain(project.name);
      expect(await commands.handle(c, event(`status ${project.id}`))).not.toContain(project.name);
      expect(await commands.handle(c, event(`confirm ${confirmation}`))).not.toContain(
        "Redeployment requested",
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Direct chat connectors, without an assistant daemon", () => {
  const context = (owner: Actor) =>
    ({
      ...owner,
      role: "owner",
      principalKind: null,
      tokenScope: null,
      sessionKind: "cookie",
    }) as any;
  let botSequence = 900000000;
  function transportFixture(options: { receiver?: any } = {}) {
    const sent: any[] = [];
    const menus: any[] = [];
    let unavailable = false;
    let webhook = "";
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (unavailable) throw new Error("failure must not expose the token in " + url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const bot = url.match(/bot(\d+):/)?.[1] ?? "1";
      let result: any = true;
      if (url.endsWith("/getMe")) result = { id: Number(bot), is_bot: true, username: `bot${bot}` };
      else if (url.endsWith("/getWebhookInfo")) result = { url: webhook };
      else if (url.endsWith("/setMyCommands")) menus.push(body.commands);
      else if (url.endsWith("/sendMessage")) sent.push(body);
      else if (url.endsWith("/answerCallbackQuery")) result = true;
      else
        throw new Error(
          "Unexpected provider endpoint " +
            new URL(url).pathname.replace(/bot[^/]+/, "bot[redacted]"),
        );
      return Response.json({ ok: true, result });
    });
    const receiver =
      options.receiver ??
      vi.fn(async (_c: any, _config: any, hooks: any) => {
        hooks.status({ state: "connected" });
        await new Promise<void>((resolve) =>
          hooks.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      });
    const transport = createDirectChatTransport({ fetch: fetcher, receiver });
    const service = createChatApps(transport);
    return {
      transport,
      service,
      fetcher,
      receiver,
      sent,
      menus,
      unavailable(value: boolean) {
        unavailable = value;
      },
      webhook(value: string) {
        webhook = value;
      },
    };
  }
  const input = (purpose: "commands" | "assistant" | "both" = "commands") => ({
    name: "Telegram",
    provider: "telegram" as const,
    purpose,
    transport: "webhook" as const,
    channelIds: ["100"],
    credentials: {
      botToken: `${++botSequence}:private_fixture_token`,
      webhookSecret: "private_fixture_webhook_secret",
    },
  });
  const incoming = (id: number, text: string, channel = 100, user = 123) =>
    JSON.stringify({
      update_id: id,
      message: { message_id: id, text, chat: { id: channel }, from: { id: user } },
    });
  async function setup(purpose: "commands" | "assistant" | "both" = "commands") {
    const owner = await actor(),
      f = transportFixture(),
      settings = input(purpose);
    const saved = await f.service.create(context(owner), "https://openship.example", settings);
    const active = await f.service.setEnabled(context(owner), saved.id, true, saved.revision);
    return {
      ...f,
      owner,
      ctx: context(owner),
      settings,
      c: (await repos.chatApps.get(active.id))!,
    };
  }

  it("starts paused and runs command-only bots without a target, provider account or Mindwire", async () => {
    const f = transportFixture(),
      owner = await actor(),
      settings = { ...input(), transport: "outbound" as const };
    const before = fixture.factory.mock.calls.length;
    try {
      const created = await f.service.create(context(owner), origin, settings);
      expect(created).toMatchObject({
        enabled: false,
        assistantAllowed: false,
        assistant: null,
        serverId: null,
      });
      expect(f.receiver).not.toHaveBeenCalled();
      expect(JSON.stringify(created)).not.toContain(settings.credentials.botToken);
      const stored = (await repos.chatApps.transport(created.id))!;
      expect(stored.configuration).not.toContain(settings.credentials.botToken);
      const active = await f.service.setEnabled(context(owner), created.id, true, created.revision);
      await f.service.tick();
      expect(f.receiver).toHaveBeenCalledTimes(1);
      const status = await f.service.status(context(owner));
      expect(status.connections[0]?.receiver?.state).toBe("connected");
      expect(f.menus.at(-1).map((x: any) => x.command)).toContain("restart");
      expect(f.menus.at(-1).map((x: any) => x.command)).not.toContain("ask");
      expect(fixture.factory.mock.calls).toHaveLength(before);
      const paused = await f.service.setEnabled(context(owner), active.id, false, active.revision);
      expect(paused.enabled).toBe(false);
      await f.service.remove(context(owner), paused.id);
      expect(await repos.chatApps.transport(paused.id)).toBeUndefined();
    } finally {
      await f.service.close();
    }
  });

  it("uses the same role-filtered catalog for menus and Slack manifest entries", () => {
    expect(chatNativeCommands("assistant").map((c) => c.name)).not.toContain("restart");
    expect(chatNativeCommands("commands").map((c) => c.name)).not.toContain("ask");
    expect(chatSlackCommands("both")).toHaveLength(chatNativeCommands("both").length + 1);
    expect(
      chatSlackCommands("commands").find((c) => c.command === "/openship-status"),
    ).toMatchObject({ usage_hint: "<project_id>" });
  });

  it("verifies webhook secrets and allowed chats before durable enqueue, then deduplicates replies", async () => {
    const f = await setup();
    try {
      const body = incoming(1, "/help");
      await expect(
        f.service.forward(f.c.id, body, { "x-telegram-bot-api-secret-token": "wrong" }),
      ).rejects.toThrow("authenticate");
      expect(await f.transport.claim(f.c)).toBeNull();
      const headers = { "x-telegram-bot-api-secret-token": f.settings.credentials.webhookSecret };
      await f.service.forward(f.c.id, incoming(2, "/help", 999), headers);
      expect(await f.transport.claim(f.c)).toBeNull();
      await Promise.all([
        f.service.forward(f.c.id, body, headers),
        f.service.forward(f.c.id, body, headers),
      ]);
      await f.service.tick();
      await f.service.tick();
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0].text).toContain("/openship projects");
      expect(await f.transport.claim(f.c)).toBeNull();
      await expect(
        f.service.forward(f.c.id, body, { "x-telegram-bot-api-secret-token": "💩".repeat(14) }),
      ).rejects.toThrow("authenticate");
    } finally {
      await f.service.close();
    }
  });

  it("reuses OAuth consent and the normal project dispatcher end to end", async () => {
    const f = await setup(),
      project = await seedProject(f.owner.organizationId, { name: "Customer app" });
    const sender = {
      integrationId: f.c.nativeId!,
      workspaceId: "",
      userId: "123",
      channelId: "100",
    };
    const before = fixture.factory.mock.calls.length;
    try {
      const auth = await authorize(f.owner, f.c, true, sender);
      const headers = { "x-telegram-bot-api-secret-token": f.settings.credentials.webhookSecret };
      await f.service.forward(f.c.id, incoming(10, `/verify ${auth.verification}`), headers);
      await f.service.tick();
      expect(f.sent.at(-1).text).toContain("connected");
      await f.service.forward(f.c.id, incoming(11, "/projects"), headers);
      await f.service.tick();
      expect(f.sent.at(-1).reply_markup.inline_keyboard.flat()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: project.name,
            callback_data: expect.stringMatching(/^os:[A-Za-z0-9_-]{32}$/),
          }),
        ]),
      );
      await f.service.forward(f.c.id, incoming(12, "/projects", 100, 999), headers);
      await f.service.tick();
      expect(JSON.stringify(f.sent.at(-1))).not.toContain(project.id);
      expect(JSON.stringify(f.sent.at(-1))).not.toContain(project.name);
      expect(fixture.factory.mock.calls).toHaveLength(before);
    } finally {
      await f.service.close();
    }
  });

  it("keeps assistant opt-in separate and preserves settings without returning credentials", async () => {
    const f = await setup(),
      outsider = await actor();
    try {
      const config = await f.service.configuration(f.ctx, f.c.id);
      expect(JSON.stringify(config)).not.toMatch(/private_fixture|credentials/);
      await expect(f.service.configuration(context(outsider), f.c.id)).rejects.toThrow("not found");
      await expect(
        f.service.setEnabled({ ...f.ctx, sessionKind: "bearer" }, f.c.id, false, f.c.revision),
      ).rejects.toThrow("session");
      const changed = await f.service.configure(f.ctx, f.c.id, {
        revision: f.c.revision,
        name: "Updated bot",
        purpose: "both",
        transport: "webhook",
        channelIds: ["200"],
        credentials: {},
      });
      expect(changed).toMatchObject({
        name: "Updated bot",
        assistantAllowed: true,
        assistant: null,
        linked: false,
      });
      expect(f.menus.at(-1).map((x: any) => x.command)).toContain("ask");
      expect(f.menus.at(-1).map((x: any) => x.command)).toContain("restart");
      expect((await f.service.configuration(f.ctx, f.c.id)).channelIds).toEqual(["200"]);
      await expect(f.service.setEnabled(f.ctx, f.c.id, false, f.c.revision)).rejects.toThrow(
        "changed",
      );
      await expect(
        f.service.configureAssistant(f.ctx, f.c.id, {
          identityId: "someone-else",
          enabled: true,
          provider: "codex",
          revision: 1,
        }),
      ).rejects.toThrow("own chat");
      f.unavailable(true);
      const paused = await f.service.setEnabled(f.ctx, f.c.id, false, changed.revision);
      expect(paused.enabled).toBe(false); // Pausing needs neither a provider nor an assistant.
      await expect(f.service.setEnabled(f.ctx, f.c.id, true, paused.revision)).rejects.toThrow(
        "paused",
      );
      expect((await repos.chatApps.get(f.c.id))!.enabled).toBe(false);
      expect(JSON.stringify(await f.service.status(f.ctx))).not.toContain(
        f.settings.credentials.botToken,
      );
    } finally {
      await f.service.close();
    }
  });

  it("does not silently delete a Telegram webhook or leave failed setup records", async () => {
    const f = transportFixture(),
      owner = await actor(),
      settings = { ...input(), transport: "outbound" as const };
    try {
      f.unavailable(true);
      await expect(f.service.create(context(owner), origin, settings)).rejects.toThrow("provider");
      expect(await repos.chatApps.list(owner.organizationId)).toHaveLength(0);
      f.unavailable(false);
      const saved = await f.service.create(context(owner), origin, settings);
      f.webhook("https://another-service.example/hook");
      await expect(
        f.service.setEnabled(context(owner), saved.id, true, saved.revision),
      ).rejects.toThrow("already has a webhook");
      expect(f.fetcher.mock.calls.some(([url]) => url.includes("deleteWebhook"))).toBe(false);
      expect((await repos.chatApps.get(saved.id))?.enabled).toBe(false);
      await expect(f.service.forward(saved.id, "{}", {})).rejects.toThrow();
    } finally {
      await f.service.close();
    }
  });

  it("elects one receiver across replicas and fences stale receivers after a settings change", async () => {
    const f = transportFixture(),
      owner = await actor(),
      settings = { ...input(), transport: "outbound" as const };
    const second = createDirectChatTransport({ fetch: f.fetcher, receiver: f.receiver });
    try {
      const created = await f.service.create(context(owner), origin, settings);
      const active = await f.service.setEnabled(context(owner), created.id, true, created.revision);
      const c = (await repos.chatApps.get(active.id))!;
      await Promise.all([f.transport.poll(c), second.poll(c)]);
      expect(f.receiver).toHaveBeenCalledTimes(1);
      const hooks = f.receiver.mock.calls[0][2];
      const payload = {
        id: "duplicate",
        userId: "123",
        workspaceId: "",
        channelId: "100",
        text: "help",
        command: true,
      };
      await Promise.all([hooks.receive(payload), hooks.receive(payload)]);
      const claimed = await f.transport.claim(c);
      expect(claimed).not.toBeNull();
      expect(await second.claim(c)).toBeNull();
      await repos.chatApps.update(c.id, c.revision, { enabled: false });
      await expect(hooks.receive({ ...payload, id: "stale" })).rejects.toThrow("changed");
      await expect(f.transport.complete(c, claimed!, chatReply("must not send"))).rejects.toThrow(
        "disabled or changed",
      );
      expect(f.sent).toEqual([]);
    } finally {
      await f.service.close();
      await second.close();
    }
  });

  it("never repeats an ambiguous provider send", async () => {
    const f = await setup();
    try {
      await f.service.forward(f.c.id, incoming(20, "/help"), {
        "x-telegram-bot-api-secret-token": f.settings.credentials.webhookSecret,
      });
      const event = (await f.transport.claim(f.c))!;
      f.unavailable(true);
      await expect(f.transport.complete(f.c, event, chatReply("reply"))).rejects.toThrow(
        "provider",
      );
      f.unavailable(false);
      await f.transport.complete(f.c, event, chatReply("reply"));
      expect(f.sent).toEqual([]);
      expect(await f.transport.claim(f.c)).toBeNull();
    } finally {
      await f.service.close();
    }
  });

  it("connects Cloud bots without provisioning any tenant host, while isolating credentials and access", async () => {
    const before = env.CLOUD_MODE,
      f = transportFixture(),
      owner = await actor(),
      outsider = await actor();
    const nativeCalls = fixture.factory.mock.calls.length;
    env.CLOUD_MODE = true;
    try {
      const settings = input();
      const created = await f.service.create(
        context(owner),
        "https://cloud.openship.example",
        settings,
      );
      expect(created.serverId).toBeNull();
      expect((await f.service.status(context(outsider))).connections).toEqual([]);
      await expect(f.service.remove(context(outsider), created.id)).rejects.toThrow("not found");
      await expect(
        f.service.configure(context(outsider), created.id, {
          ...settings,
          revision: created.revision,
        }),
      ).rejects.toThrow("not found");
      await expect(
        f.service.create(context(outsider), "https://cloud.openship.example", settings),
      ).rejects.toThrow("already connected");
      expect(await repos.chatApps.list(outsider.organizationId)).toEqual([]);
      const active = await f.service.setEnabled(context(owner), created.id, true, created.revision);
      expect(active.enabled).toBe(true);
      expect(fixture.factory.mock.calls).toHaveLength(nativeCalls);
    } finally {
      env.CLOUD_MODE = before;
      await f.service.close();
    }
  });
  it("delivers linking instructions and the URL as two separate localized messages, once", async () => {
    const f = await setup();
    try {
      await repos.settings.setLocale(f.owner.userId, "ar");
      const body = incoming(201, "/openship link");
      const headers = { "x-telegram-bot-api-secret-token": f.settings.credentials.webhookSecret };
      await f.service.forward(f.c.id, body, headers);
      await f.service.tick();
      expect(f.sent).toHaveLength(2);
      expect(f.sent[0].text).toContain("افتح الرابط في الرسالة التالية");
      expect(f.sent[0].text).not.toContain("http");
      expect(f.sent[1].text).toMatch(
        /^http:\/\/localhost:3001\/settings\?tab=chat-apps&link=[\w-]+$/,
      );
      expect(f.sent[1].link_preview_options).toEqual({ is_disabled: true });
      await f.service.forward(f.c.id, body, headers);
      await f.service.tick();
      expect(f.sent).toHaveLength(2);
      await repos.settings.setLocale(f.owner.userId, "fr");
      await f.service.forward(f.c.id, incoming(202, "/openship link"), headers);
      await f.service.tick();
      expect(f.sent[2].text).toContain("prochain message");
      expect((await repos.settings.findByUser((await actor()).userId))?.locale).toBeUndefined();
    } finally {
      await f.service.close();
    }
  });

  it("runs Telegram project and confirmation buttons through consent and the normal deployment route", async () => {
    const f = await setup();
    const sender = {
      integrationId: f.c.nativeId!,
      workspaceId: "",
      channelId: "100",
      userId: "123",
    };
    const headers = { "x-telegram-bot-api-secret-token": f.settings.credentials.webhookSecret };
    const post = async (id: number, text: string) => {
      await f.service.forward(f.c.id, incoming(id, text), headers);
      await f.service.tick();
    };
    const press = async (id: number, token: string, user = 123) => {
      await f.service.forward(
        f.c.id,
        JSON.stringify({
          update_id: id,
          callback_query: {
            id: String(id),
            data: token,
            from: { id: user },
            message: {
              message_id: 99,
              chat: { id: 100 },
              from: { id: Number(f.settings.credentials.botToken.split(":")[0]), is_bot: true },
            },
          },
        }),
        headers,
      );
      await f.service.tick();
    };
    const button = (text: string) =>
      f.sent
        .at(-1)
        .reply_markup.inline_keyboard.flat()
        .find((b: any) => b.text.includes(text)).callback_data;
    const restart = vi
      .spyOn(deploymentService, "restartDeployment")
      .mockResolvedValue(undefined as never);
    try {
      const pairing = await authorize(f.owner, f.c, false, sender);
      expect(await commands.handle(f.c, event(`verify ${pairing.verification}`, sender))).toContain(
        "connected",
      );
      const project = await seedProject(f.owner.organizationId, { name: "Button app" });
      const dep = await seedDeployment(project);
      await setActive(project.id, dep.id);
      restart.mockResolvedValue(dep);
      await post(210, "/start");
      expect(f.sent.at(-1).text).toContain("Your apps");
      const choose = button("Choose a project");
      await press(211, choose, 999);
      expect(f.sent.at(-1).text).toContain("expired");
      expect(f.sent.at(-1).text).not.toContain(project.name);
      await press(212, choose);
      const projectButton = button("Button app");
      await press(213, projectButton);
      expect(f.sent.at(-1).text).toContain("ready");
      const restartButton = button("Restart");
      await press(214, restartButton);
      expect(restart).not.toHaveBeenCalled();
      expect(f.sent.at(-1).text).toContain("Running services will restart");
      const confirm = button("Confirm");
      await press(215, confirm, 999);
      expect(restart).not.toHaveBeenCalled();
      await press(216, confirm);
      expect(restart).toHaveBeenCalledTimes(1);
      await press(217, confirm);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(f.sent.at(-1).text).toContain("expired");
      expect(
        f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/answerCallbackQuery")),
      ).toBe(true);
      // The same grammar also accepts terminal-style command paths.
      await post(218, `/openship project get ${project.id}`);
      expect(f.sent.at(-1).text).toContain("ready");
      await press(219, button("Restart"));
      const pending = button("Confirm");
      const binding = (await repos.personalAccessToken.findOAuthBinding(
        f.owner.userId,
        pairing.clientId,
      ))!;
      await db
        .update(schema.personalAccessToken)
        .set({ readOnly: true })
        .where(eq(schema.personalAccessToken.id, binding.id));
      await press(222, pending);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(f.sent.at(-1).text).toContain("approved access");

      const other = await setup();
      try {
        const denied = await createStructuredCommands().handle(
          other.c,
          event("help", {
            integrationId: other.c.nativeId!,
            workspaceId: "",
            channelId: "100",
            userId: "123",
            callback: projectButton.slice(3),
          }),
        );
        expect(denied?.messages[0]?.text).toContain("expired");
        expect(JSON.stringify(denied)).not.toContain(project.name);
      } finally {
        await other.service.close();
      }
    } finally {
      restart.mockRestore();
      await f.service.close();
    }
  });

  it("resumes after a confirmed first message without repeating it, and fences an ambiguous second send", async () => {
    const f = await setup();
    try {
      const headers = { "x-telegram-bot-api-secret-token": f.settings.credentials.webhookSecret };
      await f.service.forward(f.c.id, incoming(220, "/link"), headers);
      const event = (await f.transport.claim(f.c))!;
      const reply = (await createStructuredCommands().handle(f.c, event))!;
      // Simulate a worker exiting after persisting successful delivery of message one.
      const first = await repos.chatApps.beginDelivery(f.c.id, event.id, f.c.revision, event.lease);
      expect(first?.deliveredCount).toBe(0);
      await repos.chatApps.delivered(event.id, event.lease, 0, false);
      await db
        .update(schema.chatAppInbox)
        .set({ leaseUntil: new Date(0) })
        .where(eq(schema.chatAppInbox.id, event.id));
      const resumed = (await f.transport.claim(f.c))!;
      expect(resumed.lease).not.toBe(event.lease);
      await f.transport.complete(
        f.c,
        resumed,
        (await createStructuredCommands().handle(f.c, resumed))!,
      );
      expect(f.sent.map((m) => m.text)).toEqual([reply.messages[1]!.text]);
      expect((await repos.chatApps.inboxEvent(event.id))?.payload).toBe("");

      await f.service.forward(f.c.id, incoming(221, "/link"), headers);
      const next = (await f.transport.claim(f.c))!;
      const response = (await createStructuredCommands().handle(f.c, next))!;
      const real = f.fetcher.getMockImplementation()!;
      let count = 0;
      f.fetcher.mockImplementation(async (url, init) => {
        if (url.endsWith("/sendMessage") && ++count === 2) throw new Error("uncertain outcome");
        return real(url, init);
      });
      await expect(f.transport.complete(f.c, next, response)).rejects.toThrow("provider");
      expect((await repos.chatApps.inboxEvent(next.id))?.deliveredCount).toBe(1);
      f.fetcher.mockImplementation(real);
      const before = f.sent.length;
      await f.transport.complete(f.c, next, response);
      expect(f.sent).toHaveLength(before);
    } finally {
      await f.service.close();
    }
  });
});

const chatAssistant = createChatAssistant(assistant);
const chatMessages = createChatCommands(undefined, chatAssistant);
async function enableAgent(a: Actor, readOnly = true, targetId?: string) {
  const prepared = await data(a, "/api/assistant/enable", { targetId });
  await data(a, "/api/tokens/mcp-authorize", {
    clientId: prepared.clientId,
    organizationId: a.organizationId,
    fullAccess: true,
    readOnly,
    grants: [],
  });
  const accepted = await request(a, "POST", "/api/auth/oauth2/consent", {
    accept: true,
    consent_code: prepared.consentCode,
  });
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  const callback = (await accepted.json()).redirectURI;
  expect((await request(a, "GET", callback)).status).toBe(302);
  return prepared.clientId as string;
}
async function enableChat(a: Actor, c: Awaited<ReturnType<typeof connection>>, sender = "sender") {
  const identity = (await repos.chatApps.identity(c.id, "team", sender))!;
  const response = await request(a, "PUT", `/api/chat-apps/${c.id}/assistant`, {
    identityId: identity.id,
    revision: identity.assistantRevision,
    enabled: true,
    provider: "codex",
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await repos.chatApps.identityById(identity.id))!;
}
async function chatReady(readOnly = true) {
  const linkedUser = await linked();
  const agentClient = await enableAgent(linkedUser.owner, readOnly);
  const c = (await repos.chatApps.update(linkedUser.c.id, linkedUser.c.revision, {
    assistantAllowed: true,
  }))!;
  const identity = await enableChat(linkedUser.owner, c);
  return { ...linkedUser, c, agentClient, identity };
}
async function assistantReply(c: Awaited<ReturnType<typeof connection>>, message: HostEvent) {
  for (let n = 0; n < 60; n++) {
    const response = await chatMessages.handle(c, message);
    if (response !== null) return response;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("Assistant reply did not settle");
}
async function tool(
  options: any,
  method: string,
  path: string,
  args: Record<string, unknown> = {},
) {
  const selected = getMcpTools().find(
    (t) => t.method === method && t.path.replace(/\/$/, "") === path,
  )!;
  const mcp = options.options.mcpServers.mcpServers.openship;
  const r = await fetch(mcp.url, {
    method: "POST",
    headers: { ...(mcp.headers ?? mcp.httpHeaders), "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name: selected.name, arguments: args },
    }),
  });
  return { status: r.status, data: await r.json() };
}

describe("Chat assistant uses the existing runtime and permissions", () => {
  beforeEach(() => {
    fixture.script = undefined;
  });
  it("requires both workspace permission and personal opt-in; bearer tokens cannot enable it", async () => {
    const { owner, c, clientId } = await linked();
    const started = fixture.runs.length;
    expect(await chatMessages.handle(c, event("ask Hello"))).toContain("Enable your assistant");
    const identity = (await repos.chatApps.identity(c.id, "team", "sender"))!;
    const input = {
      identityId: identity.id,
      revision: identity.assistantRevision,
      enabled: true,
      provider: "codex",
    };
    expect((await request(owner, "PUT", `/api/chat-apps/${c.id}/assistant`, input)).status).toBe(
      409,
    );
    const current = (await repos.chatApps.update(c.id, c.revision, { assistantAllowed: true }))!;
    expect(await chatMessages.handle(current, event("ask Hello"))).toContain(
      "Enable your assistant",
    );
    expect((await request(owner, "PUT", `/api/chat-apps/${c.id}/assistant`, input)).status).toBe(
      403,
    );
    await enableAgent(owner);
    const token = (await repos.oauth.findClientToken(owner.userId, clientId))!.accessToken;
    expect(
      (
        await app.request(`${origin}/api/chat-apps/${c.id}/assistant`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(403);
    expect(fixture.runs.length).toBe(started);
    expect((await request(owner, "PUT", `/api/chat-apps/${c.id}/assistant`, input)).status).toBe(
      200,
    );
    expect((await request(owner, "PUT", `/api/chat-apps/${c.id}/assistant`, input)).status).toBe(
      409,
    );
  });

  it("sends natural messages and slash-command questions through one turn path, with idempotent replies", async () => {
    const { c, owner } = await chatReady();
    const started = fixture.runs.length;
    const message = event("ask Check my apps\nKeep the reply short.");
    expect(await chatMessages.handle(c, message)).toBeNull();
    const reply = await assistantReply(c, message);
    expect(reply).toContain("Check my apps\nKeep the reply short.");
    expect(await chatMessages.handle(c, { ...message, lease: "reclaimed" })).toBe(reply);
    expect(fixture.runs.length).toBe(started + 1);
    const first = fixture.runs.at(-1);
    expect(first.options.options.systemPrompt).toContain("MCP");
    expect(first.options.options.systemPrompt).toContain("chat app");
    expect(first.options.options.settings.permissionMode).toBe("never");
    expect(await assistantReply(c, event("Tell me more", { command: false }))).toContain(
      "Tell me more",
    );
    expect(fixture.runs.at(-1).chatId).toBe(first.chatId);
    const conversation = (await repos.assistant.list(owner))[0]!;
    const interactive = await request(
      owner,
      "POST",
      `/api/assistant/conversations/${conversation.id}/turns`,
      { requestId: randomUUID(), message: "Continue from dashboard" },
    );
    expect(interactive.status).toBe(200);
    expect(fixture.runs.at(-1).chatId).toBe(first.chatId);
    expect(await chatMessages.handle(c, { ...message, channelId: "other" })).toContain("changed");
  });

  it("never lends the installer's agent or mixes senders, channels, threads or workspaces", async () => {
    const { c, owner } = await chatReady();
    const peer = await actor();
    await db.insert(schema.member).values({
      id: randomUUID(),
      userId: peer.userId,
      organizationId: owner.organizationId,
      role: "admin",
    });
    const teammate = { ...peer, organizationId: owner.organizationId };
    await db
      .update(schema.session)
      .set({ activeOrganizationId: owner.organizationId })
      .where(eq(schema.session.userId, peer.userId));
    const pairing = await authorize(teammate, c, true, { userId: "teammate" });
    await commands.handle(c, event(`verify ${pairing.verification}`, { userId: "teammate" }));
    const before = fixture.runs.length;
    expect(await chatMessages.handle(c, event("ask Hello", { userId: "teammate" }))).toContain(
      "Enable your assistant",
    );
    expect(fixture.runs.length).toBe(before);
    await enableAgent(teammate);
    await enableChat(teammate, c, "teammate");
    const messages = [
      event("ask owner"),
      event("ask teammate", { userId: "teammate" }),
      event("ask thread", { threadId: "thread-1" }),
      event("ask channel", { channelId: "channel-2" }),
    ];
    for (const message of messages) await assistantReply(c, message);
    expect(new Set(fixture.runs.slice(before).map((r) => r.chatId)).size).toBe(4);
    const ownRows = await repos.assistant.list(owner),
      peerRows = await repos.assistant.list(teammate);
    expect(ownRows).toHaveLength(3);
    expect(peerRows).toHaveLength(1);
    expect(
      (await request(teammate, "GET", `/api/assistant/conversations/${ownRows[0]!.id}`)).status,
    ).toBe(404);
    const outsider = await actor();
    await enableAgent(outsider);
    expect(
      (await request(outsider, "GET", `/api/assistant/conversations/${ownRows[0]!.id}`)).status,
    ).toBe(404);
  });

  it("keeps a delayed chat reply tied to its original native turn after dashboard continuation", async () => {
    const { c, owner } = await chatReady();
    const original = event("ask Original chat turn");
    expect(await chatMessages.handle(c, original)).toBeNull();
    const row = (await repos.assistant.list(owner))[0]!;
    await vi.waitFor(async () =>
      expect((await repos.assistant.find(owner, row.id))?.state).toBe("done"),
    );
    const first = fixture.runs.at(-1);
    const next = await request(owner, "POST", `/api/assistant/conversations/${row.id}/turns`, {
      requestId: randomUUID(),
      message: "Private later dashboard turn",
    });
    expect(next.status).toBe(200);
    await vi.waitFor(async () =>
      expect((await repos.assistant.find(owner, row.id))?.state).toBe("done"),
    );
    expect(fixture.runs.at(-1).chatId).toBe(first.chatId);
    const replica = createAssistantRuntime(fixture.factory);
    const otherWorker = createChatCommands(undefined, createChatAssistant(replica));
    const reply = await otherWorker.handle(c, original);
    await replica.close();
    expect(reply).toContain("Original chat turn");
    expect(reply).not.toContain("Private later dashboard turn");
    expect(await chatMessages.handle(c, { ...original, lease: "replacement" })).toBe(reply);
  });

  it("preserves native history through new and resume without leaking other chat contexts", async () => {
    const { c, owner } = await chatReady();
    const original = event("ask First conversation");
    await assistantReply(c, original);
    const first = (await repos.assistant.list(owner))[0]!;
    const nativeId = fixture.runs.at(-1).chatId;
    expect(await chatMessages.handle(c, event("new"))).toContain("Earlier chats");
    await assistantReply(c, event("ask Second conversation"));
    const second = (await repos.assistant.list(owner))[0]!;
    expect(first.id).not.toBe(second.id);
    const list = await chatMessages.handle(c, event("chats"));
    expect(list).toContain(first.id);
    expect(list).toContain(second.id);
    expect(
      await chatMessages.handle(c, event(`resume ${first.id}`, { channelId: "other" })),
    ).toContain("not found here");
    expect(
      await chatMessages.handle(c, event(`resume ${first.id}`, { threadId: "other" })),
    ).toContain("not found here");
    expect(await chatMessages.handle(c, event("chats", { channelId: "other" }))).not.toContain(
      first.id,
    );
    const outsider = await chatReady();
    expect(await chatMessages.handle(outsider.c, event(`resume ${first.id}`))).toContain(
      "not found here",
    );
    expect(await chatMessages.handle(c, event(`resume ${first.id}`))).toContain(
      "history is preserved",
    );
    expect(await chatMessages.handle(c, event("chat"))).toContain(first.id);
    await assistantReply(c, event("ask Continue the first"));
    expect(fixture.runs.at(-1).chatId).toBe(nativeId);
    expect(
      (
        await repos.chatApps.threads(
          (await repos.chatApps.identity(c.id, "team", "sender"))!.id,
          senderKey(original),
        )
      ).filter((t) => t.active),
    ).toHaveLength(1);
    expect(await chatMessages.handle(c, original)).toContain("First conversation");
  });

  it("enforces dedicated bot roles for both direct commands and natural-language messages", async () => {
    const { c } = await chatReady();
    const before = fixture.runs.length;
    const assistantOnly = (await repos.chatApps.update(c.id, c.revision, {
      purpose: "assistant",
    }))!;
    expect(await chatMessages.handle(assistantOnly, event("projects"))).toContain(
      "not enabled for this bot",
    );
    expect(await chatMessages.handle(assistantOnly, event("confirm stolen-code"))).toContain(
      "not enabled for this bot",
    );
    const help = await chatMessages.handle(assistantOnly, event("help"));
    expect(help).toContain("/openship resume");
    expect(help).not.toContain("/openship restart");
    expect(
      await assistantReply(assistantOnly, event("A natural message", { command: false })),
    ).toContain("A natural message");
    const commandsOnly = (await repos.chatApps.update(c.id, assistantOnly.revision, {
      purpose: "commands",
    }))!;
    expect(
      await chatMessages.handle(commandsOnly, event("Should not run", { command: false })),
    ).toContain("not enabled for this bot");
    expect(await chatMessages.handle(commandsOnly, event("chats"))).toContain(
      "not enabled for this bot",
    );
    expect(await chatMessages.handle(commandsOnly, event("help"))).not.toContain("/openship ask");
    expect(fixture.runs.length).toBe(before + 1);
  });

  it("does not resume a superseded grant or switch away from a still-running conversation", async () => {
    const { c, owner, identity } = await chatReady();
    await assistantReply(c, event("ask Earlier"));
    const first = (await repos.assistant.list(owner))[0]!;
    const historyEvent = event("chats");
    expect(await chatMessages.handle(c, historyEvent)).toContain(first.id);
    await chatMessages.handle(c, event("new"));
    fixture.script = async function* (run) {
      yield { type: "text", text: "Working" };
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
    };
    await chatMessages.handle(c, event("ask Wait"));
    expect(await chatMessages.handle(c, event(`resume ${first.id}`))).toContain("still working");
    await chatMessages.handle(c, event("stop"));
    expect(await chatMessages.handle(c, event(`resume ${first.id}`))).toContain(
      "history is preserved",
    );
    await request(owner, "PUT", `/api/chat-apps/${c.id}/assistant`, {
      identityId: identity.id,
      revision: identity.assistantRevision,
      enabled: false,
    });
    expect(await chatMessages.handle(c, event(`resume ${first.id}`))).toContain(
      "Enable your assistant",
    );
    const reply = await request(owner, "POST", `/api/assistant/conversations/${first.id}/turns`, {
      requestId: randomUUID(),
      message: "Cannot bypass disconnect in dashboard",
    });
    expect(reply.status).toBe(403);
    await enableChat(owner, c);
    expect(await chatMessages.handle(c, historyEvent)).toContain("changed");
    expect(await chatMessages.handle(c, event(`resume ${first.id}`))).toContain("not found here");
  });

  it("uses the sender's ordinary MCP authorization for reads and writes", async () => {
    const { c, owner } = await chatReady(true);
    const project = await seedProject(owner.organizationId, { name: "Visible to this sender" });
    const other = await actor(),
      foreign = await seedProject(other.organizationId, { name: "Another tenant secret" });
    const dep = await seedDeployment(project);
    await setActive(project.id, dep.id);
    const results: any[] = [];
    fixture.script = async function* (_run, options) {
      results.push(await tool(options, "GET", "/api/projects"));
      results.push(await tool(options, "GET", "/api/projects/:id", { id: foreign.id }));
      results.push(await tool(options, "POST", "/api/deployments/:id/restart", { id: dep.id }));
      yield { type: "thinking", text: "private model reasoning" };
      yield {
        type: "tool_result",
        tool: { id: "one", name: "test", output: "private raw tool output" },
      };
      yield { type: "text", text: "Checked your apps within your approved permissions." };
    };
    const spy = vi.spyOn(deploymentService, "restartDeployment");
    try {
      const reply = await assistantReply(c, event("ask Check and restart"));
      expect(JSON.stringify(results[0])).toContain(project.name);
      expect(JSON.stringify(results[0])).not.toContain(foreign.name);
      expect(JSON.stringify(results[1])).not.toContain(foreign.name);
      expect(
        results[2].data.result?.isError ?? results[2].data.error ?? results[2].status >= 400,
      ).toBeTruthy();
      expect(spy).not.toHaveBeenCalled();
      expect(reply).toContain("Checked your apps");
      expect(reply).not.toContain("private model reasoning");
      expect(reply).not.toContain("private raw tool output");
    } finally {
      spy.mockRestore();
    }
  });

  it("supports stop and new without blocking a connector behind a running model", async () => {
    const { c } = await chatReady();
    fixture.script = async function* (run) {
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
      yield { type: "text", text: "old result" };
    };
    const message = event("ask Long investigation");
    expect(await chatMessages.handle(c, message)).toBeNull();
    const run = fixture.runs.at(-1);
    expect(await chatMessages.handle(c, event("ask Competing prompt"))).toContain("still working");
    expect(await chatMessages.handle(c, event("stop"))).toContain("Stopped");
    expect(run.cancelled).toBe(true);
    expect(await assistantReply(c, message)).toContain("stopped");
    expect(await chatMessages.handle(c, event("new"))).toContain("New conversation");
    fixture.script = undefined;
    await assistantReply(c, event("ask Fresh start"));
    expect(fixture.runs.at(-1).chatId).not.toBe(run.chatId);
  });

  it("recovers a missing conversation without replaying its original message", async () => {
    const { c, owner } = await chatReady();
    const original = event("ask Original question");
    await assistantReply(c, original);
    const previous = (await repos.assistant.list(owner))[0]!;
    await repos.assistant.remove(owner, previous.id);
    const before = fixture.runs.length;
    expect(await chatMessages.handle(c, original)).toContain("approved access");
    expect(await assistantReply(c, event("ask New question"))).toContain("New question");
    expect(fixture.runs.length).toBe(before + 1);
    expect((await repos.assistant.list(owner))[0]!.id).not.toBe(previous.id);
    await expect(
      chatMessages.handle(c, event("ask Forged", { integrationId: "different-host" })),
    ).rejects.toThrow("another connector");
    expect(fixture.runs.length).toBe(before + 1);
  });

  it("can answer a model question through the same structured response flow", async () => {
    const { c } = await chatReady();
    fixture.script = async function* (run) {
      const wait = new Promise<void>((resolve) => {
        run.release = resolve;
      });
      yield {
        type: "interaction",
        interaction: {
          id: "which-app",
          kind: "input",
          responseMode: "native",
          needsResponse: true,
          runId: run.id,
          questions: [{ id: "app", title: "Which app?", allowOther: true }],
        },
      };
      await wait;
      yield { type: "text", text: "I will inspect Storefront." };
    };
    const question = await assistantReply(c, event("ask Check an app"));
    expect(question).toContain("Which app?");
    expect(question).toContain("/openship ask <answer>");
    expect(await assistantReply(c, event("ask Storefront"))).toContain("I will inspect Storefront");
    expect(fixture.runs.at(-1).respond).toHaveBeenCalledWith({
      interactionId: "which-app",
      answers: { app: { text: "Storefront" } },
    });
  });

  it("delivers a message-mode answer from its resumed native run, without replaying the question", async () => {
    const { c } = await chatReady();
    fixture.script = async function* () {
      yield {
        type: "interaction",
        interaction: {
          id: randomUUID(),
          kind: "input",
          responseMode: "message",
          needsResponse: true,
          questions: [{ id: "app", title: "Which app?", allowOther: true }],
        },
      };
    };
    const question = event("ask Ask me which app");
    expect(await assistantReply(c, question)).toContain("Which app?");
    await vi.waitFor(() => expect(fixture.runs.at(-1).status).toBe("done"));
    const first = fixture.runs.at(-1);
    const before = fixture.runs.length;
    fixture.script = undefined;
    const answer = event("ask Storefront");
    const text = await assistantReply(c, answer);
    expect(text).toContain("Storefront");
    expect(fixture.runs.at(-1).chatId).toBe(first.chatId);
    expect(fixture.runs.length).toBe(before + 1);
    expect(await chatMessages.handle(c, answer)).toBe(text);
    expect(fixture.runs.length).toBe(before + 1);
    expect(await chatMessages.handle(c, question)).toContain("Which app?");
  });

  it("a delayed reply deadline cannot stop a newer dashboard turn", async () => {
    const { c, owner } = await chatReady();
    const original = event("ask Earlier completed message");
    await chatMessages.handle(c, original);
    const row = (await repos.assistant.list(owner))[0]!;
    await vi.waitFor(async () =>
      expect((await repos.assistant.find(owner, row.id))?.state).toBe("done"),
    );
    const first = fixture.runs.at(-1);
    fixture.script = async function* (run) {
      yield { type: "text", text: "Still investigating" };
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
    };
    expect(
      (
        await request(owner, "POST", `/api/assistant/conversations/${row.id}/turns`, {
          requestId: randomUUID(),
          message: "Later dashboard work",
        })
      ).status,
    ).toBe(200);
    const current = fixture.runs.at(-1);
    // Simulate a delayed native snapshot from the old turn at the deadline.
    first.status = "running";
    await db
      .update(schema.chatAppCommand)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(schema.chatAppCommand.id, fingerprint([c.id, original.id])));
    expect(await chatMessages.handle(c, original)).toContain("time limit");
    expect(current.cancelled).toBe(false);
    first.status = "done";
    await chatMessages.handle(c, event("stop"));
  });

  it("blocks results and cancels running work when personal chat access is switched off", async () => {
    const { c, owner, identity } = await chatReady();
    fixture.script = async function* (run) {
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
      yield { type: "text", text: "sensitive late answer" };
    };
    const message = event("ask Inspect");
    await chatMessages.handle(c, message);
    const run = fixture.runs.at(-1);
    expect(
      (
        await request(owner, "PUT", `/api/chat-apps/${c.id}/assistant`, {
          identityId: identity.id,
          revision: identity.assistantRevision,
          enabled: false,
        })
      ).status,
    ).toBe(200);
    expect(await chatMessages.handle(c, message)).not.toContain("sensitive");
    await vi.waitFor(() => expect(run.cancelled).toBe(true), { timeout: 5000, interval: 30 });
  });

  it("rejects results after an assistant grant change, unlink, or membership removal", async () => {
    for (const change of ["grant", "unlink", "membership"]) {
      const { c, owner, agentClient } = await chatReady();
      const message = event("ask Private reply");
      const reply = await assistantReply(c, message);
      expect(reply).toContain("Private reply");
      if (change === "grant") {
        const binding = (await repos.personalAccessToken.findOAuthBinding(
          owner.userId,
          agentClient,
        ))!;
        await db
          .update(schema.personalAccessToken)
          .set({ readOnly: false })
          .where(eq(schema.personalAccessToken.id, binding.id));
      } else if (change === "unlink") await commands.handle(c, event("unlink"));
      else await db.delete(schema.member).where(eq(schema.member.userId, owner.userId));
      expect(await chatMessages.handle(c, message)).not.toContain("Private reply");
    }
  });

  it("polls and delivers the final reply after a host lease expires without replaying the model", async () => {
    const { c } = await chatReady();
    const message = event("ask Final reply");
    const queue: HostEvent[] = [message];
    const delivered: string[] = [];
    let expire = true;
    const transport = {
      async poll() {
        return { state: "connected" };
      },
      async sweep() {},
      async close() {},
      async claim(connection: any) {
        return connection.id === c.id ? (queue.shift() ?? null) : null;
      },
      async complete(
        _c: any,
        _event: any,
        text: import("../../../src/modules/chat-apps/chat-reply").ChatReply,
      ) {
        if (expire) throw fail("expired", 409);
        delivered.push(text.messages.map((m) => m.text).join("\n"));
      },
    } as unknown as ChatTransport;
    const service = createChatApps(transport, assistant);
    const before = fixture.runs.length;
    try {
      await service.tick();
      await vi.waitFor(() => expect(fixture.runs.at(-1).status).toBe("done"));
      await service.tick();
      expire = false;
      queue.push({ ...message, lease: "renewed" });
      await service.tick();
      expect(delivered.some((text) => text.includes("Final reply"))).toBe(true);
      expect(fixture.runs.length).toBe(before + 1);
      expect(await repos.chatApps.pendingReplies(c.id)).toEqual([]);
    } finally {
      await service.close();
    }
  });
});
