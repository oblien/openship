import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const fixture = vi.hoisted(() => {
  process.env.DEPLOY_MODE = "desktop";
  process.env.OPENSHIP_AUTH_MODE = "local";
  process.env.OPENSHIP_LOCAL_DASHBOARD_URL = "http://localhost:3001";
  process.env.OPENSHIP_RATE_LIMIT_STORE = "memory";
  process.env.BETTER_AUTH_SECRET = "assistant-integration-test-secret-0123456789";
  return {
    forward: vi.fn(),
    factory: vi.fn(),
    script: undefined as undefined | ((run: any, options: any) => AsyncGenerator<any>),
    runs: [] as any[],
    history: [] as any[],
    uploads: new Map<string, any>(),
    bots: new Map<string, any>(),
    botChats: new Map<string, string>(),
    botVersion: 9,
    nativeConfigured: true,
    imageInput: true,
    customCapability: true,
    startGate: undefined as Promise<void> | undefined,
    onStarting: undefined as (() => void) | undefined,
  };
});
vi.mock("../../../src/app", () => ({ app: { fetch: fixture.forward } }));
vi.mock("../../../src/modules/assistant/assistant.service", async (original) => {
  const module =
    await original<typeof import("../../../src/modules/assistant/assistant.service")>();
  return { ...module, assistant: module.createAssistantRuntime(fixture.factory) };
});
import { db, repos, schema, eq, and } from "@repo/db";
import { seedOrg, seedProject, seedDeployment, setActive } from "../../helpers/seed";
import {
  createAssistantAutomations,
  automationRecommendation,
} from "../../../src/modules/assistant/automation.service";
import { captureAssistantAutomationEvent } from "@repo/platform/engine/modules/assistant/automation-events";
import { resolveExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import type { AssistantAutomationConfig } from "@repo/contracts";
import { env } from "@repo/platform/engine/config/env";
import { auth } from "@repo/platform/engine/lib/auth";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import {
  assistant,
  createAssistantRuntime,
} from "../../../src/modules/assistant/assistant.service";
import { assistantRoutes } from "../../../src/modules/assistant/assistant.routes";
import { authRoutes } from "../../../src/modules/auth/auth.routes";
import { tokenRoutes } from "../../../src/modules/tokens/token.routes";
import { mcpRoutes } from "../../../src/modules/mcp/mcp.routes";
import { permissionsRoutes } from "../../../src/modules/permissions/permissions.routes";
import { deploymentRoutes } from "../../../src/modules/deployments/deployment.routes";
import { dispatchTool } from "../../../src/modules/mcp/mcp-dispatch";
import { githubRoutes } from "../../../src/modules/github/github.routes";
import * as githubAuth from "@repo/platform/engine/modules/github/github.auth";
import { parseAssistantAutomationReport } from "@repo/contracts";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { forceMcpConsent } from "../../../src/middleware/mcp-consent";
import { clientIpMiddleware } from "../../../src/middleware/client-ip";
import { handleApiError } from "../../../src/middleware/error-handler";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";
import { getMcpTools, resetMcpToolCache } from "../../../src/modules/mcp/mcp-tools";

const origin = "http://localhost:4000";
const app = new Hono()
  .onError(handleApiError)
  .use("*", clientIpMiddleware)
  .use("/api/auth/mcp/authorize", forceMcpConsent)
  .route("/api/auth", authRoutes)
  .route("/api/tokens", tokenRoutes)
  .route("/api/assistant", assistantRoutes)
  .route("/api/mcp", mcpRoutes)
  .route("/api/permissions", permissionsRoutes)
  .route("/api/github", githubRoutes)
  .route("/api/projects", projectRoutes)
  .route("/api/deployments", deploymentRoutes);

beforeAll(() => {
  fixture.forward.mockImplementation((request) => app.fetch(request));
  resetMcpToolCache();
  fixture.factory.mockImplementation(async () => {
    const custom: Record<string, any> = {};
    return {
      healthy: () => true,
      close: async () => {},
      workspace: async () => "/tmp/assistant-test-no-exec",
      probe: async () => ({ available: true, version: "test" }),
      mindwire: {
        health: async () => ({ botsVersion: fixture.botVersion }),
        workspace: {
          snapshot: async () => ({ projects: [] }),
          projects: { put: async () => ({}) },
          ensureAgent: async (input: any) => ({ agentId: input.agentType }),
        },
        bots: {
          create: async (input: any) => {
            const bot = fixture.bots.get(input.id) ?? { ...input, revision: 1, archived: false };
            fixture.bots.set(input.id, bot);
            return { bot };
          },
          get: async (id: string) => {
            const bot = fixture.bots.get(id);
            if (!bot) throw new Error("Native bot not found");
            return bot;
          },
          update: async (id: string, input: any) => {
            const previous = fixture.bots.get(id);
            if (!previous || input.expectedRevision !== previous.revision)
              throw new Error("Native revision conflict");
            const bot = { ...previous, ...input, revision: previous.revision + 1 };
            fixture.bots.set(id, bot);
            return { bot };
          },
          createChat: async (id: string, input: any) => fixture.botChats.set(input.chatId, id),
        },
        withAgent() {
          return this;
        },
        agent: async () => ({
          schema: { sections: [] },
          authStatus: { configured: fixture.nativeConfigured },
          capabilities: {
            customProviders: true,
            customProviderModels: fixture.customCapability,
            imageInput: fixture.imageInput,
          },
          authMethods: [],
        }),
        getConfig: async () => ({}),
        models: async () => [
          { id: "test-model-a", label: "Model A" },
          { id: "test-model-b", label: "Model B" },
          ...Object.values(custom).flatMap((p) =>
            p.models.map((model: string) => ({
              id: `${p.id}/${model}`,
              label: model,
              custom: true,
            })),
          ),
        ],
        providers: {
          list: async () => ({ user: custom }),
          set: async (id: string, provider: any, input: any) => {
            custom[id] = { id, ...provider, hasKey: !!input.apiKey };
          },
        },
        uploadAttachment: async (chatId: string, image: any) => {
          const id = randomUUID();
          fixture.uploads.set(id, {
            id,
            chatId,
            mime: image.mime,
            bytes: image.data.length,
            data: image.data.toString("base64"),
          });
          return { artifactId: id, name: image.name, mime: image.mime, bytes: image.data.length };
        },
        surfaces: { artifact: async (id: string) => fixture.uploads.get(id) },
        messagePage: async () => ({ messages: fixture.history, hasMore: false }),
        deleteChat: async () => {},
        run: async (id: string) => fixture.runs.find((r) => r.id === id),
        turn: async (options: any) => {
          fixture.onStarting?.();
          await fixture.startGate;
          const run: any = {
            id: randomUUID(),
            chatId: options.chatId,
            status: "running",
            inputs: [],
            cancelled: false,
            options,
          };
          run.refresh = async () => run;
          run.cancel = async () => {
            run.cancelled = true;
            run.status = "cancelled";
            run.release?.();
          };
          run.sendInput = vi.fn(async (text, input) => {
            if (!run.inputs.some((i: any) => i.requestId === input.requestId))
              run.inputs.push({ text, ...input });
          });
          run.respond = vi.fn(async () => {});
          const script = fixture.script;
          run.stream = async function* () {
            if (script) yield* script(run, options);
            else yield { type: "text", text: "Your apps are healthy." };
            if (!run.cancelled) run.status = "done";
          };
          fixture.runs.push(run);
          return run;
        },
      },
    };
  });
});
afterAll(async () => {
  await assistant.close();
  await shutdownRateLimit();
});

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
  const cookie = `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
  return { ...owner, cookie };
}
type Actor = Awaited<ReturnType<typeof actor>>;
async function request(
  owner: Actor,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const routed = new URL(path.startsWith("http") ? path : `${origin}/api/assistant${path}`);
  if (routed.pathname.startsWith("/api/proxy/"))
    routed.pathname = routed.pathname.slice("/api/proxy".length);
  return app.request(routed.href, {
    method,
    headers: {
      cookie: owner.cookie,
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function data(owner: Actor, method: string, path: string, body?: unknown) {
  const res = await request(owner, method, path, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()).data;
}
async function connect(owner: Actor, readOnly = true, targetId?: string) {
  const started = await data(owner, "POST", "/enable", { targetId });
  const { clientId, consentCode, state } = started;
  expect(started.organizationId).toBe(owner.organizationId);
  expect(consentCode).toBeTruthy();
  // Preparing the embedded form cannot mint a token or opt the user in.
  expect(await repos.oauth.findClientToken(owner.userId, clientId)).toBeUndefined();
  const authorization = new URL(
    fixture.forward.mock.calls
      .map(([request]) => (request as Request).url)
      .findLast((url) => url.includes(`/api/auth/mcp/authorize?`) && url.includes(clientId))!,
  );
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("state")).toBe(state);
  await data(owner, "POST", `${origin}/api/tokens/mcp-authorize`, {
    clientId,
    organizationId: owner.organizationId,
    fullAccess: true,
    readOnly,
    grants: [],
  });
  const grant = await request(owner, "POST", `${origin}/api/auth/oauth2/consent`, {
    accept: true,
    consent_code: consentCode,
  });
  expect(grant.status, await grant.clone().text()).toBe(200);
  const callback = (await grant.json()).redirectURI;
  const completed = await request(owner, "GET", callback, undefined, {
    accept: "application/json",
  });
  expect(completed.status, await completed.clone().text()).toBe(200);
  expect(await completed.json()).toEqual({ data: { enabled: true } });
  expect(completed.headers.get("location")).toBeNull();
  expect(await data(owner, "GET", "/status")).toMatchObject({ enabled: true, clientId });
  return { clientId, callback };
}
async function chat(owner: Actor) {
  return data(owner, "POST", "/conversations", { provider: "codex" });
}
async function settle(owner: Actor, id: string) {
  for (let i = 0; i < 50; i++) {
    const snapshot = await data(owner, "GET", `/conversations/${id}`);
    if (!["running", "waiting"].includes(snapshot.activity.state)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Turn did not settle");
}
const rpc = async (options: any, method: string, params?: unknown) => {
  const connection = options.options.mcpServers.mcpServers.openship;
  const res = await fetch(connection.url, {
    method: "POST",
    headers: {
      ...(connection.headers ?? connection.httpHeaders),
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return res.json();
};

describe("Assistant: normal OAuth → MCP → HTTP authorization", () => {
  it("prepares inline consent without enabling or starting an agent, and cancellation leaves it off", async () => {
    const owner = await actor(),
      before = fixture.factory.mock.calls.length;
    const prepared = await data(owner, "POST", "/enable", {});
    expect(Object.keys(prepared).sort()).toEqual([
      "clientId",
      "consentCode",
      "organizationId",
      "state",
    ]);
    expect(await data(owner, "GET", "/status")).toMatchObject({ enabled: false });
    expect((await request(owner, "GET", "/providers")).status).toBe(403);
    const denied = await request(owner, "POST", `${origin}/api/auth/oauth2/consent`, {
      accept: false,
      consent_code: prepared.consentCode,
    });
    expect(denied.status).toBe(200);
    const callback = (await denied.json()).redirectURI;
    const completed = await request(owner, "GET", callback, undefined, {
      accept: "application/json",
    });
    expect(await completed.json()).toEqual({ data: { enabled: false } });
    expect(await repos.assistant.connection(owner)).toBeUndefined();
    expect(await repos.oauth.findClientToken(owner.userId, prepared.clientId)).toBeUndefined();
    expect(fixture.factory.mock.calls.length).toBe(before);
  });

  it("rejects a callback before consent and cannot enable another account's prepared request", async () => {
    const owner = await actor(),
      other = await actor();
    const prepared = await data(owner, "POST", "/enable", {});
    const forged = await request(
      owner,
      "GET",
      `/callback?state=${prepared.state}&code=unapproved`,
      undefined,
      { accept: "application/json" },
    );
    expect(forged.status).toBe(409);
    expect(await repos.assistant.connection(owner)).toBeUndefined();
    const next = await data(owner, "POST", "/enable", {});
    await data(other, "POST", `${origin}/api/tokens/mcp-authorize`, {
      clientId: next.clientId,
      organizationId: other.organizationId,
      readOnly: true,
      fullAccess: true,
      grants: [],
    });
    const consent = await request(other, "POST", `${origin}/api/auth/oauth2/consent`, {
      accept: true,
      consent_code: next.consentCode,
    });
    expect(consent.status).toBe(200);
    // The code retains its original user. A binding approved by another user
    // cannot satisfy the callback's exact user/workspace identity check.
    const callback = (await consent.json()).redirectURI;
    const completed = await request(other, "GET", callback, undefined, {
      accept: "application/json",
    });
    expect(completed.status).toBe(403);
    expect(await repos.assistant.connection(owner)).toBeUndefined();
    expect(await repos.assistant.connection(other)).toBeUndefined();
  });

  it("exposes notice-only Cloud controls but never uses the control plane or a foreign server", async () => {
    const owner = await actor(),
      other = await actor(),
      before = fixture.factory.mock.calls.length;
    const cloud = env.CLOUD_MODE;
    const localId = randomUUID(),
      foreignId = randomUUID();
    await db.insert(schema.servers).values([
      {
        id: localId,
        organizationId: owner.organizationId,
        isLocal: true,
        sshHost: "127.0.0.1",
        name: "Control plane",
      },
      {
        id: foreignId,
        organizationId: other.organizationId,
        sshHost: "203.0.113.19",
        name: "Foreign server",
      },
    ]);
    try {
      env.CLOUD_MODE = true;
      expect(await data(owner, "GET", "/status")).toMatchObject({
        available: true,
        enabled: false,
        targets: [],
      });
      expect((await request(owner, "POST", "/enable", {})).status).toBe(403);
      expect((await request(owner, "POST", "/enable", { targetId: "local" })).status).toBe(403);
      expect((await request(owner, "POST", "/enable", { targetId: localId })).status).toBe(403);
      expect((await request(owner, "POST", "/enable", { targetId: foreignId })).status).toBe(404);
      expect((await request(owner, "GET", "/providers")).status).toBe(403);
      expect(fixture.factory.mock.calls.length).toBe(before);
    } finally {
      env.CLOUD_MODE = cloud;
    }
  });

  it("denied MCP consent without state returns safely without enabling access", async () => {
    const owner = await actor();
    const response = await request(owner, "GET", "/callback?error=access_denied");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3001/assistant?authorization=cancelled",
    );
    expect(await repos.assistant.connection(owner)).toBeUndefined();
  });

  it("keeps an active turn alive across API replicas and accepts a stop from another replica", async () => {
    const owner = await actor();
    await connect(owner);
    const created = await chat(owner);
    const member = (await repos.member.find(owner.organizationId, owner.userId))!;
    const user = (await repos.user.findById(owner.userId))!;
    const context = {
      ...owner,
      user: { id: user.id, email: user.email, name: user.name },
      role: "owner" as const,
      membershipId: member.id,
      sessionId: "replica-session",
      sessionKind: "cookie" as const,
      clientIp: null,
      userAgent: null,
      traceId: "replica-test",
    };
    const replica = createAssistantRuntime(fixture.factory);
    fixture.script = async function* (run) {
      yield { type: "text", text: "Working" };
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
    };
    try {
      await data(owner, "POST", `/conversations/${created.id}/turns`, {
        requestId: randomUUID(),
        message: "Inspect status only",
      });
      const run = fixture.runs.at(-1);
      expect((await replica.get(context, created.id)).activity.state).toBe("running");
      expect(run.cancelled).toBe(false);
      await expect(
        replica.start(context, created.id, { requestId: randomUUID(), message: "Competing turn" }),
      ).rejects.toMatchObject({ code: "ASSISTANT_BUSY" });
      await replica.stop(context, created.id);
      await vi.waitFor(() => expect(run.cancelled).toBe(true), { timeout: 5000 });
      expect((await settle(owner, created.id)).activity.state).toBe("cancelled");
    } finally {
      fixture.script = undefined;
      await replica.close();
    }
  });

  it("uses the self-hosted public proxy for its callback and the ordinary MCP endpoint for tools", async () => {
    const owner = await actor(),
      previous = env.OPENSHIP_PUBLIC_URL;
    env.OPENSHIP_PUBLIC_URL = "https://assistant-self-hosted.example.test";
    try {
      const { callback, clientId } = await connect(owner);
      expect(new URL(callback).pathname).toBe("/api/proxy/api/assistant/callback");
      const created = await chat(owner);
      fixture.script = async function* (_run, options) {
        const tools = await rpc(options, "tools/list");
        expect(tools.result.tools.some((t: any) => t.name === "get_projects")).toBe(true);
        const access = await rpc(options, "tools/call", {
          name: "get_permissions_access_request",
          arguments: {
            query: {
              reason: "User asked to deploy.",
              access: "Write access to the selected project.",
            },
          },
        });
        expect(JSON.parse(access.result.content[0].text).data).toMatchObject({
          granted: false,
          clientId,
          organizationId: owner.organizationId,
        });
        yield { type: "text", text: "Scoped MCP through the existing proxy." };
      };
      await data(owner, "POST", `/conversations/${created.id}/turns`, {
        requestId: randomUUID(),
        message: "List available tools",
      });
      expect((await settle(owner, created.id)).activity.state).toBe("done");
    } finally {
      fixture.script = undefined;
      env.OPENSHIP_PUBLIC_URL = previous;
    }
  });

  it("binds Cloud consent and native execution to an owned paid server, using normal HTTPS MCP", async () => {
    const owner = await actor(),
      serverId = randomUUID();
    await db.insert(schema.servers).values({
      id: serverId,
      organizationId: owner.organizationId,
      name: "Customer server",
      sshHost: "203.0.113.27",
    });
    await repos.managementBilling.ensure(
      owner.organizationId,
      `fixture-management-${owner.organizationId}`,
    );
    await repos.managementBilling.update(owner.organizationId, {
      checkedAt: new Date(),
      verified: {
        servers: 2,
        baseIncluded: false,
        priceCents: 500,
        periodEnd: new Date(Date.now() + 86400000).toISOString(),
        cancelAtPeriodEnd: false,
        status: "active",
      },
    });
    const cloud = env.CLOUD_MODE,
      advertised = env.OPENSHIP_ADVERTISED_ORIGIN;
    env.CLOUD_MODE = true;
    env.OPENSHIP_ADVERTISED_ORIGIN = "https://assistant-cloud.example.test";
    try {
      const { clientId } = await connect(owner, true, serverId);
      expect(await data(owner, "GET", "/status")).toMatchObject({
        enabled: true,
        target: { id: serverId, kind: "server" },
      });
      const created = await chat(owner);
      fixture.script = async function* (_run, options) {
        const mcp = options.options.mcpServers.mcpServers.openship;
        expect(mcp.url).toBe("https://assistant-cloud.example.test/api/mcp");
        const response = await fixture.forward(
          new Request(mcp.url, {
            method: "POST",
            headers: { ...mcp.httpHeaders, "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          }),
        );
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.result.tools.some((tool: any) => tool.name === "get_projects")).toBe(true);
        expect(
          result.result.tools.some((tool: any) => tool.name === "get_permissions_access_request"),
        ).toBe(true);
        const accessResponse = await fixture.forward(
          new Request(mcp.url, {
            method: "POST",
            headers: { ...mcp.httpHeaders, "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "get_permissions_access_request",
                arguments: {
                  query: {
                    reason: "User asked to deploy.",
                    access: "Write access to the selected project.",
                  },
                },
              },
            }),
          }),
        );
        expect(accessResponse.status).toBe(200);
        const access = await accessResponse.json();
        expect(JSON.parse(access.result.content[0].text).data).toMatchObject({
          granted: false,
          clientId,
          organizationId: owner.organizationId,
        });
        yield { type: "text", text: "Customer host, approved tools." };
      };
      await data(owner, "POST", `/conversations/${created.id}/turns`, {
        requestId: randomUUID(),
        message: "Inspect available apps",
      });
      expect((await settle(owner, created.id)).activity.state).toBe("done");
      expect(fixture.factory.mock.calls.at(-1)?.[0]).toMatchObject({
        serverId,
        userId: owner.userId,
        organizationId: owner.organizationId,
      });
      await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
      expect(await data(owner, "GET", "/status")).toMatchObject({ enabled: false, target: null });
      expect((await request(owner, "GET", "/providers")).status).toBe(403);
    } finally {
      fixture.script = undefined;
      env.CLOUD_MODE = cloud;
      env.OPENSHIP_ADVERTISED_ORIGIN = advertised;
    }
  });

  it("is off without starting Mindwire and keeps native authentication private", async () => {
    const owner = await actor(),
      calls = fixture.factory.mock.calls.length;
    expect(await data(owner, "GET", "/status")).toMatchObject({
      available: true,
      enabled: false,
      clientId: null,
    });
    expect((await request(owner, "GET", "/providers")).status).toBe(403);
    expect(fixture.factory.mock.calls.length).toBe(calls);
    const pat = mintPatToken();
    await repos.personalAccessToken.create({
      userId: owner.userId,
      organizationId: owner.organizationId,
      name: "test",
      tokenPrefix: pat.tokenPrefix,
      tokenHash: pat.tokenHash,
      readOnly: false,
      scoped: false,
      expiresAt: null,
    });
    expect(
      (
        await app.request(`${origin}/api/assistant/enable`, {
          method: "POST",
          headers: { authorization: `Bearer ${pat.token}`, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      getMcpTools().some((t) =>
        /\/assistant\/(providers|enable|disable|custom-api|conversations)/.test(t.path),
      ),
    ).toBe(false);
  });
  it("uses actual consent, rejects state replay, and forwards only the approved MCP tools", async () => {
    const owner = await actor(),
      other = await actor();
    const { callback } = await connect(owner);
    expect((await request(owner, "GET", callback)).status).toBe(400);
    const created = await chat(owner);
    let discovered: any, read: any, denied: any, foreign: any;
    fixture.script = async function* (_run, options) {
      discovered = await rpc(options, "tools/list");
      read = await rpc(options, "tools/call", {
        name: "get_permissions_workspaces",
        arguments: {},
      });
      denied = await rpc(options, "tools/call", {
        name: "post_projects",
        arguments: { body: { name: "Never created" } },
      });
      foreign = await rpc(options, "tools/call", {
        name: "get_permissions_workspaces",
        arguments: { organizationId: other.organizationId },
      });
      yield { type: "text", text: "Read-only workspace checked." };
    };
    await data(owner, "POST", `/conversations/${created.id}/turns`, {
      requestId: randomUUID(),
      message: "Check my workspace",
    });
    const snapshot = await settle(owner, created.id);
    expect(snapshot.activity.state).toBe("done");
    expect(discovered.result.tools.map((t: any) => t.name)).toContain("get_permissions_workspaces");
    expect(discovered.result.tools.map((t: any) => t.name)).not.toContain("post_projects");
    expect(JSON.stringify(read)).toContain(owner.organizationId);
    expect(JSON.stringify(read)).not.toContain(other.organizationId);
    expect(denied.error || denied.result?.isError).toBeTruthy();
    expect(foreign.result.isError).toBe(true);
    expect((await repos.project.listByOrganization(owner.organizationId)).total).toBe(0);
    expect((await request(other, "GET", `/conversations/${created.id}`)).status).toBe(403);
    await connect(other);
    expect((await request(other, "GET", `/conversations/${created.id}`)).status).toBe(404);
    fixture.script = undefined;
  });
  it("requests access without granting it, then uses only user-approved permissions in a new conversation", async () => {
    const owner = await actor(),
      other = await actor();
    const { clientId } = await connect(owner);
    const group = await repos.projectGroup.create({
      organizationId: owner.organizationId,
      name: "Access test",
      slug: `access-${randomUUID()}`,
    });
    const project = await repos.project.create({
      organizationId: owner.organizationId,
      groupId: group.id,
      name: "Before approval",
      slug: `access-${randomUUID()}`,
      gitProvider: "upload",
    });
    const edit = (readOnly: boolean, permissions: string[]) => ({
      mode: "edit",
      clientId,
      organizationId: owner.organizationId,
      readOnly,
      fullAccess: false,
      grants: [{ resourceType: "project", resourceId: project.id, permissions }],
    });
    await data(owner, "POST", `${origin}/api/tokens/mcp-authorize`, edit(true, ["read"]));
    const created = await chat(owner);
    const input = {
      reason: "Renaming the project needs write access.",
      access: "Read and write access to the Before approval project only.",
    };
    let requested: any, denied: any, foreign: any, discovered: any;
    const update = {
      name: "patch_projects_by_id",
      arguments: { id: project.id, body: { name: "After approval" } },
    };
    try {
      fixture.script = async function* (_run, options) {
        discovered = await rpc(options, "tools/list");
        const result = await rpc(options, "tools/call", {
          name: "get_permissions_access_request",
          arguments: { query: input },
        });
        requested = JSON.parse(result.result.content[0].text).data;
        yield {
          type: "tool_use",
          tool: {
            id: "access",
            name: "mcp__openship__get_permissions_access_request",
            input: { query: input },
          },
        };
        yield { type: "tool_result", tool: { id: "access", output: result.result } };
        denied = await rpc(options, "tools/call", update);
        foreign = await rpc(options, "tools/call", {
          name: "get_permissions_access_request",
          arguments: { query: input, organizationId: other.organizationId },
        });
      };
      await data(owner, "POST", `/conversations/${created.id}/turns`, {
        requestId: randomUUID(),
        message: "Rename my project",
      });
      expect((await settle(owner, created.id)).activity.state).toBe("done");
      expect(requested).toEqual({
        ...input,
        kind: "permission_request",
        granted: false,
        clientId,
        organizationId: owner.organizationId,
        reviewPath: "/settings?tab=mcp",
      });
      const names = discovered.result.tools.map((t: any) => t.name);
      expect(names).toContain("get_permissions_access_request");
      expect(names).not.toContain("patch_projects_by_id");
      expect(
        names.some(
          (name: string) => name.includes("mcp_authorize") || name === "post_permissions_grants",
        ),
      ).toBe(false);
      expect(denied.error || denied.result?.isError).toBeTruthy();
      expect(foreign.result.isError).toBe(true);
      expect((await repos.project.findById(project.id))?.name).toBe("Before approval");
      const binding = (await repos.personalAccessToken.findOAuthBinding(owner.userId, clientId))!;
      expect(binding).toMatchObject({ readOnly: true, scoped: true });
      expect((await repos.patGrant.listByToken(binding.id)).map((g) => g.permissions)).toEqual([
        ["read"],
      ]);
      expect(
        (
          await request(
            other,
            "POST",
            `${origin}/api/tokens/mcp-authorize`,
            edit(false, ["read", "write"]),
          )
        ).status,
      ).toBe(404);
      const unscoped = await request(owner, "POST", `${origin}/api/tokens/mcp-authorize`, {
        ...edit(false, []),
        fullAccess: true,
        grants: [],
      });
      expect(unscoped.status).toBe(400);
      expect(await unscoped.json()).toMatchObject({ code: "SCOPE_WIDEN_NOT_CONFIRMED" });
      // The same endpoint used by the shared editor, with an explicit, scoped user choice.
      await data(
        owner,
        "POST",
        `${origin}/api/tokens/mcp-authorize`,
        edit(false, ["read", "write"]),
      );
      expect((await data(owner, "GET", `/conversations/${created.id}`)).accessChanged).toBe(true);
      expect(
        (
          await request(owner, "POST", `/conversations/${created.id}/turns`, {
            requestId: randomUUID(),
            message: "Continue",
          })
        ).status,
      ).toBe(403);
      let updated: any;
      fixture.script = async function* (_run, options) {
        updated = await rpc(options, "tools/call", update);
        yield { type: "text", text: "Renamed through the normal project tool." };
      };
      const fresh = await chat(owner);
      await data(owner, "POST", `/conversations/${fresh.id}/turns`, {
        requestId: randomUUID(),
        message: "Rename my project",
      });
      expect((await settle(owner, fresh.id)).activity.state).toBe("done");
      expect(updated.result.isError, JSON.stringify(updated)).toBe(false);
      expect((await repos.project.findById(project.id))?.name).toBe("After approval");
    } finally {
      fixture.script = undefined;
    }
  });
  it("deduplicates concurrent sends and rejects changed message reuse", async () => {
    const owner = await actor();
    await connect(owner);
    const created = await chat(owner);
    const input = { requestId: randomUUID(), message: "Inspect only" },
      before = fixture.runs.length;
    fixture.script = async function* (run) {
      yield { type: "text", text: "Inspecting" };
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
    };
    await Promise.all([
      data(owner, "POST", `/conversations/${created.id}/turns`, input),
      data(owner, "POST", `/conversations/${created.id}/turns`, input),
    ]);
    expect(fixture.runs.length - before).toBe(1);
    expect(
      (
        await request(owner, "POST", `/conversations/${created.id}/turns`, {
          ...input,
          message: "Different work",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(owner, "POST", `/conversations/${created.id}/turns`, {
          requestId: randomUUID(),
          message: "Second work",
        })
      ).status,
    ).toBe(409);
    await data(owner, "POST", `/conversations/${created.id}/stop`);
    expect((await settle(owner, created.id)).activity.state).toBe("cancelled");
    await data(owner, "POST", `/conversations/${created.id}/turns`, input);
    expect(fixture.runs.length - before).toBe(1);
    fixture.script = undefined;
  });
  it("refreshes the canonical OAuth token without changing the approved access", async () => {
    const owner = await actor();
    const { clientId } = await connect(owner);
    const original = await repos.oauth.findClientToken(owner.userId, clientId);
    const created = await chat(owner);
    await db
      .update(schema.oauthAccessToken)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.oauthAccessToken.id, original!.id));
    expect((await data(owner, "GET", "/status")).enabled).toBe(true);
    const renewed = await repos.oauth.findClientToken(owner.userId, clientId);
    expect(renewed!.accessToken).not.toBe(original!.accessToken);
    expect(renewed!.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect((await data(owner, "GET", `/conversations/${created.id}`)).accessChanged).toBe(false);
  });
  it("rechecks access before forwarding each live MCP request", async () => {
    const owner = await actor();
    const { clientId } = await connect(owner);
    const created = await chat(owner);
    fixture.script = async function* (run) {
      yield { type: "text", text: "Waiting" };
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
    };
    try {
      await data(owner, "POST", `/conversations/${created.id}/turns`, {
        requestId: randomUUID(),
        message: "Inspect apps",
      });
      const run = fixture.runs.at(-1);
      const connection = run.options.options.mcpServers.mcpServers.openship;
      expect((await rpc(run.options, "tools/list")).result.tools.length).toBeGreaterThan(0);
      await repos.oauth.disconnectMcpClient(owner.userId, clientId);
      const response = await fetch(connection.url, {
        method: "POST",
        headers: {
          ...(connection.headers ?? connection.httpHeaders),
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Assistant access is no longer available." });
      await data(owner, "POST", `/conversations/${created.id}/stop`);
      expect(run.cancelled).toBe(true);
    } finally {
      fixture.script = undefined;
    }
  });
  it("serializes deletion with an in-flight start so no orphan turn can continue", async () => {
    const owner = await actor();
    await connect(owner);
    const created = await chat(owner);
    let release!: () => void;
    fixture.startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starting = new Promise<void>((resolve) => {
      fixture.onStarting = resolve;
    });
    fixture.script = async function* (run) {
      yield { type: "text", text: "Waiting" };
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
    };
    try {
      const turn = data(owner, "POST", `/conversations/${created.id}/turns`, {
        requestId: randomUUID(),
        message: "Inspect apps",
      });
      await starting;
      const deletion = data(owner, "DELETE", `/conversations/${created.id}`);
      release();
      await Promise.all([turn, deletion]);
      expect(fixture.runs.at(-1).cancelled).toBe(true);
      expect((await request(owner, "GET", `/conversations/${created.id}`)).status).toBe(404);
    } finally {
      release();
      fixture.script = undefined;
      fixture.onStarting = undefined;
      fixture.startGate = undefined;
    }
  });
  it("rejects native approval and fences a conversation when MCP permissions change", async () => {
    const owner = await actor();
    const { clientId } = await connect(owner);
    const created = await chat(owner);
    fixture.script = async function* () {
      yield {
        type: "interaction",
        interaction: {
          id: "native-shell",
          kind: "approval",
          needsResponse: true,
          options: [{ id: "approve", label: "Run shell" }],
        },
      };
    };
    await data(owner, "POST", `/conversations/${created.id}/turns`, {
      requestId: randomUUID(),
      message: "Use a native shell",
    });
    expect((await settle(owner, created.id)).activity.state).toBe("cancelled");
    expect(fixture.runs.at(-1).respond).not.toHaveBeenCalled();
    const binding = await repos.personalAccessToken.findOAuthBinding(owner.userId, clientId);
    await db
      .update(schema.personalAccessToken)
      .set({ readOnly: false })
      .where(eq(schema.personalAccessToken.id, binding!.id));
    expect((await data(owner, "GET", `/conversations/${created.id}`)).accessChanged).toBe(true);
    expect(
      (
        await request(owner, "POST", `/conversations/${created.id}/turns`, {
          requestId: randomUUID(),
          message: "Continue",
        })
      ).status,
    ).toBe(403);
    fixture.script = undefined;
  });
  it("persists question acknowledgements without duplicating answers or saving a second transcript", async () => {
    const owner = await actor();
    await connect(owner);
    const created = await chat(owner);
    const question = {
      id: "which-app",
      kind: "form",
      needsResponse: true,
      responseMode: "message",
      questions: [{ id: "app", title: "Which app?", options: [{ id: "api", label: "API" }] }],
    };
    fixture.script = async function* (run) {
      yield { type: "interaction", interaction: question };
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
    };
    await data(owner, "POST", `/conversations/${created.id}/turns`, {
      requestId: randomUUID(),
      message: "Inspect an app",
    });
    const run = fixture.runs.at(-1);
    const answer = {
      interactionId: question.id,
      requestId: randomUUID(),
      answers: { app: { options: ["api"] } },
    };
    await data(owner, "POST", `/conversations/${created.id}/respond`, answer);
    await data(owner, "POST", `/conversations/${created.id}/respond`, {
      ...answer,
      requestId: randomUUID(),
    });
    expect(run.sendInput).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(owner, "POST", `/conversations/${created.id}/respond`, {
          ...answer,
          answers: { app: { text: "Other" } },
        })
      ).status,
    ).toBe(409);
    expect(
      JSON.stringify((await data(owner, "GET", `/conversations/${created.id}`)).messages),
    ).toContain('"needsResponse":false');
    run.release();
    await settle(owner, created.id);
    fixture.script = undefined;
  });
  it("disconnects through the normal MCP revocation path and cancels the active turn", async () => {
    const owner = await actor();
    const { clientId } = await connect(owner);
    const created = await chat(owner);
    fixture.script = async function* (run) {
      yield { type: "text", text: "Waiting" };
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
    };
    await data(owner, "POST", `/conversations/${created.id}/turns`, {
      requestId: randomUUID(),
      message: "Check apps",
    });
    const run = fixture.runs.at(-1);
    await data(owner, "POST", "/disable");
    expect(run.cancelled).toBe(true);
    expect(await repos.oauth.findClientToken(owner.userId, clientId)).toBeUndefined();
    expect((await data(owner, "GET", "/status")).enabled).toBe(false);
    expect(
      (
        await request(owner, "POST", `/conversations/${created.id}/turns`, {
          requestId: randomUUID(),
          message: "Continue",
        })
      ).status,
    ).toBe(403);
    fixture.script = undefined;
  });
});

describe("Private custom API connections", () => {
  it("keeps native login separate, routes a custom model, and excludes another tenant", async () => {
    const owner = await actor(),
      stranger = await actor();
    await connect(owner);
    await connect(stranger);
    fixture.nativeConfigured = false;
    const secret = "private-api-key-fixture";
    try {
      const connection = await data(owner, "POST", "/custom-api", {
        name: "My model",
        baseUrl: "https://model.example/v1",
        apiKey: secret,
        model: "provider/model",
      });
      const providers = await data(owner, "GET", "/providers");
      const custom = providers.find((p: any) => p.id === "codex");
      expect(custom.authStatus.configured).toBe(false);
      expect(custom.customProviders[0]).toMatchObject({
        name: "My model",
        hasKey: true,
        baseUrl: "https://model.example/v1",
      });
      expect(JSON.stringify(providers)).not.toContain(secret);
      expect(
        (await data(stranger, "GET", "/providers")).flatMap((p: any) => p.customProviders ?? []),
      ).toHaveLength(0);
      const own = await data(owner, "POST", "/conversations", {
        provider: "codex",
        model: connection.model,
      });
      await data(owner, "POST", `/conversations/${own.id}/turns`, {
        requestId: randomUUID(),
        message: "Read my app status",
      });
      await settle(owner, own.id);
      expect(fixture.runs.at(-1).options.options.settings).toMatchObject({
        model: connection.model,
      });
      const other = await data(stranger, "POST", "/conversations", {
        provider: "codex",
        model: connection.model,
      });
      expect(
        (
          await request(stranger, "POST", `/conversations/${other.id}/turns`, {
            requestId: randomUUID(),
            message: "Borrow connection",
          })
        ).status,
      ).toBe(409);
      fixture.customCapability = false;
      expect(
        (
          await request(owner, "POST", `/conversations/${own.id}/turns`, {
            requestId: randomUUID(),
            message: "Use an older runtime",
          })
        ).status,
      ).toBe(409);
    } finally {
      fixture.nativeConfigured = true;
      fixture.customCapability = true;
    }
  });
  it("rejects credentials in URLs, unsafe schemes, and API keys submitted before enablement", async () => {
    const owner = await actor();
    const input = {
      name: "My API",
      baseUrl: "https://model.example/v1",
      apiKey: "fixture-only",
      model: "m",
    };
    expect((await request(owner, "POST", "/custom-api", input)).status).toBe(403);
    await connect(owner);
    for (const baseUrl of [
      "https://user:secret@model.example/v1",
      "https://model.example/v1?key=secret",
      "http://example.com",
      "file:///etc/passwd",
    ])
      expect((await request(owner, "POST", "/custom-api", { ...input, baseUrl })).status).toBe(400);
  });
});

describe("Assistant automations: persisted events → scoped agent → approval → normal dispatcher", () => {
  const baseSha = "a".repeat(40),
    treeSha = "b".repeat(40),
    nextTree = "c".repeat(40),
    nextCommit = "d".repeat(40);
  const patch = {
    baseBranch: "main",
    baseSha,
    title: "Handle missing configuration",
    description: "Review CI before merging; not executed by the investigator.",
    files: [
      { path: "src/app.ts", content: "export const healthy = true;\n" },
      { path: "src/health.ts", content: "export const timeout = 5000;\n" },
    ],
  };
  function repositoryTransport(
    options: {
      stale?: boolean;
      symlink?: boolean;
      failPr?: boolean;
      before?: (call: any) => Promise<void>;
    } = {},
  ) {
    let heads = 0;
    return vi
      .spyOn(githubAuth, "githubFetch")
      .mockImplementation(async (call: any): Promise<any> => {
        expect(call.authorizeAs).toBe("write");
        expect(call.owner).toBe("fixture");
        expect(call.repo).toBe("app");
        await options.before?.(call);
        const path = new URL(call.url).pathname.replace("/repos/fixture/app", "");
        if (path === "/git/ref/heads/main")
          return { object: { sha: options.stale && ++heads > 1 ? "e".repeat(40) : baseSha } };
        if (path === `/git/commits/${baseSha}`) return { tree: { sha: treeSha } };
        if (path === `/git/trees/${treeSha}`)
          return {
            truncated: false,
            tree: [
              { path: "src", type: "tree", mode: "040000" },
              { path: "src/app.ts", type: "blob", mode: options.symlink ? "120000" : "100755" },
            ],
          };
        if (path === "/git/trees") return { sha: nextTree };
        if (path === "/git/commits")
          return {
            sha: nextCommit,
            html_url: `https://github.com/fixture/app/commit/${nextCommit}`,
          };
        if (path === "/git/refs") return { ref: call.params.ref };
        if (path === "/pulls") {
          if (options.failPr) throw new Error("lost response");
          return { html_url: "https://github.com/fixture/app/pull/1" };
        }
        throw new Error(`Unexpected GitHub request ${path}`);
      });
  }
  async function setup(
    overrides: Partial<AssistantAutomationConfig> = {},
    projectOverrides: Partial<typeof schema.project.$inferInsert> = {},
  ) {
    const owner = await actor();
    await connect(owner, false);
    const project = await seedProject(owner.organizationId, {
      name: "Automation app",
      ...projectOverrides,
    });
    const config: AssistantAutomationConfig = {
      name: "Investigate a failed deploy",
      projectId: project.id,
      trigger: "deployment.failed",
      provider: "codex",
      model: "",
      mode: "report",
      action: "none",
      instructions: "",
      channelIds: [],
      cooldownMinutes: 30,
      dailyLimit: 5,
      enabled: true,
      automaticConsent: false,
      ...overrides,
    };
    const saved = await data(owner, "POST", "/automations", config);
    const deployment = await seedDeployment(project, {
      status: "failed",
      createdAt: new Date(Date.now() + 10),
    });
    const event = {
      organizationId: owner.organizationId,
      eventType: "deployment.failed",
      resourceType: "deployment",
      resourceId: deployment.id,
    };
    const rule = (await repos.assistantAutomations.find(owner, saved.id))!;
    const ctx = await resolveExecutionAuthority(rule.authority, "automation-integration");
    const worker = createAssistantAutomations({ runtime: assistant });
    return { owner, project, config, deployment, event, rule, ctx, worker };
  }
  async function investigated(
    test: Awaited<ReturnType<typeof setup>>,
    response = 'Evidence reviewed.\n```json\n{"action":"none"}\n```',
  ) {
    fixture.script = async function* () {
      yield { type: "text", text: response };
    };
    await captureAssistantAutomationEvent(test.event);
    await test.worker.sweep();
    let run = (await repos.assistantAutomations.runs(test.owner))[0]!;
    expect(run.state).toBe("investigating");
    await settle(test.owner, run.conversationId!);
    await test.worker.sweep();
    return (await repos.assistantAutomations.run(test.owner, run.id))!;
  }
  it("offers a read-only MCP activation review, then enables the exact batch only from a user session", async () => {
    const test = await setup({ enabled: false });
    const second = await data(test.owner, "POST", "/automations", {
      ...test.config,
      name: "Investigate an unhealthy service",
      trigger: "service.unhealthy",
    });
    const connection = (await repos.assistant.connection(test.owner))!;
    const token = (await repos.oauth.findClientToken(test.owner.userId, connection.clientId))!;
    const definition = getMcpTools().find(
      (tool) => tool.path === "/api/assistant/automation-activation-review",
    )!;
    expect(definition.name).toBe("post_assistant_automation_activation_review");
    expect(definition.annotations.readOnlyHint).toBe(true);
    expect(getMcpTools().some((tool) => tool.path === "/api/assistant/automation-activation")).toBe(
      false,
    );
    const prepared = await dispatchTool(
      definition,
      {
        organizationId: test.owner.organizationId,
        body: { automationIds: [test.rule.id, second.id] },
      },
      token.accessToken,
      { principalKind: "oauth", principalId: connection.clientId },
    );
    expect(prepared.status, JSON.stringify(prepared.data)).toBe(200);
    const review = (prepared.data as any).data;
    expect(review).toMatchObject({
      kind: "automation_activation_review",
      organizationId: test.owner.organizationId,
    });
    expect(review.automations.map((flow: any) => flow.name)).toEqual([
      test.config.name,
      second.name,
    ]);
    expect(JSON.stringify(review)).not.toContain("accessFingerprint");
    expect(JSON.stringify(review)).not.toContain("authority");
    expect((await repos.assistantAutomations.list(test.owner)).every((flow) => !flow.enabled)).toBe(
      true,
    );
    const body = {
      automations: review.automations.map(({ id, revision }: any) => ({ id, revision })),
      automaticConsent: false,
    };
    const refused = await app.request(`${origin}/api/assistant/automation-activation`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(refused.status).toBe(403);
    const enabled = await data(test.owner, "POST", "/automation-activation", body);
    expect(enabled.automations).toHaveLength(2);
    expect(enabled.automations.every((flow: any) => flow.enabled)).toBe(true);
    expect((await request(test.owner, "POST", "/automation-activation", body)).status).toBe(409);
  });
  it("rolls back the whole activation batch when a flow changes during approval", async () => {
    const test = await setup({ enabled: false });
    const second = await data(test.owner, "POST", "/automations", {
      ...test.config,
      name: "Second flow",
    });
    const review = await data(test.owner, "POST", "/automation-activation-review", {
      automationIds: [test.rule.id, second.id],
    });
    const ordered = [...review.automations].sort((a: any, b: any) => a.id.localeCompare(b.id));
    const activate = repos.assistantAutomations.activateReviewed;
    const race = vi
      .spyOn(repos.assistantAutomations, "activateReviewed")
      .mockImplementationOnce(async (owner, inputs) => {
        // This edit lands after service validation, before the transactional compare-and-set.
        await db
          .update(schema.assistantAutomation)
          .set({ revision: ordered[1].revision + 1, name: "Changed during review" })
          .where(eq(schema.assistantAutomation.id, ordered[1].id));
        return activate(owner, inputs);
      });
    try {
      const response = await request(test.owner, "POST", "/automation-activation", {
        automations: review.automations.map(({ id, revision }: any) => ({ id, revision })),
        automaticConsent: false,
      });
      expect(response.status).toBe(409);
      expect(
        (await repos.assistantAutomations.list(test.owner)).every((flow) => !flow.enabled),
      ).toBe(true);
      expect((await repos.assistantAutomations.find(test.owner, ordered[0].id))!.revision).toBe(
        ordered[0].revision,
      );
    } finally {
      race.mockRestore();
    }
  });
  it("requires automatic-action consent and rechecks live grants during activation", async () => {
    const test = await setup({ enabled: false, mode: "automatic", action: "redeploy" });
    const body = {
      automations: [{ id: test.rule.id, revision: test.rule.revision }],
      automaticConsent: false,
    };
    expect((await request(test.owner, "POST", "/automation-activation", body)).status).toBe(400);
    const connection = (await repos.assistant.connection(test.owner))!;
    await data(test.owner, "POST", `${origin}/api/tokens/mcp-authorize`, {
      clientId: connection.clientId,
      organizationId: test.owner.organizationId,
      readOnly: true,
      fullAccess: false,
      grants: [{ resourceType: "project", resourceId: test.project.id, permissions: ["read"] }],
    });
    expect(
      (
        await request(test.owner, "POST", "/automation-activation", {
          ...body,
          automaticConsent: true,
        })
      ).status,
    ).toBe(403);
    expect((await repos.assistantAutomations.find(test.owner, test.rule.id))!.enabled).toBe(false);
  });
  it("keeps activation reviews owned and workspace scoped, and never resumes global pause", async () => {
    const test = await setup({ enabled: false }),
      stranger = await actor();
    await connect(stranger, false);
    const body = {
      automations: [{ id: test.rule.id, revision: test.rule.revision }],
      automaticConsent: false,
    };
    expect(
      (
        await request(stranger, "POST", "/automation-activation-review", {
          automationIds: [test.rule.id],
        })
      ).status,
    ).toBe(404);
    expect((await request(stranger, "POST", "/automation-activation", body)).status).toBe(404);
    expect(
      (
        await request(test.owner, "POST", "/automation-activation", {
          ...body,
          automations: [
            ...body.automations,
            { id: test.rule.id, revision: test.rule.revision + 1 },
          ],
        })
      ).status,
    ).toBe(400);
    await data(test.owner, "PATCH", "/automation-settings", { paused: true });
    const enabled = await data(test.owner, "POST", "/automation-activation", body);
    expect(enabled.paused).toBe(true);
    expect((await repos.assistantAutomations.settings(test.owner))!.paused).toBe(true);
  });
  it("keeps findings in the agent conversation without sending any unselected channel", async () => {
    const test = await setup();
    const run = await investigated(test);
    const view = await data(test.owner, "GET", `/automation-runs/${run.id}`);
    expect(view.state).toBe("reported");
    expect(view.conversationId).toBe(run.conversationId);
    expect(
      await db
        .select()
        .from(schema.notificationDelivery)
        .where(eq(schema.notificationDelivery.organizationId, test.owner.organizationId)),
    ).toHaveLength(0);
    expect((await request(await actor(), "GET", `/automation-runs/${run.id}`)).status).toBe(404);
    fixture.script = undefined;
  });
  it("cannot widen read-only Assistant consent or access an app outside its scope", async () => {
    const test = await setup();
    const connection = (await repos.assistant.connection(test.owner))!;
    const edit = (readOnly: boolean, projectId: string) => ({
      mode: "edit",
      clientId: connection.clientId,
      organizationId: test.owner.organizationId,
      fullAccess: false,
      readOnly,
      grants: [{ resourceType: "project", resourceId: projectId, permissions: ["read"] }],
    });
    await data(
      test.owner,
      "POST",
      `${origin}/api/tokens/mcp-authorize`,
      edit(true, test.project.id),
    );
    const permissions = await data(test.owner, "GET", `/automation-permissions/${test.project.id}`);
    expect(permissions.read.allowed).toBe(true);
    expect(permissions.actions.every((a: any) => !a.allowed)).toBe(true);
    expect(
      (
        await request(test.owner, "POST", "/automations", {
          ...test.config,
          mode: "approve",
          allowedActions: ["redeploy"],
        })
      ).status,
    ).toBe(403);
    const sibling = await seedProject(test.owner.organizationId);
    await data(test.owner, "POST", `${origin}/api/tokens/mcp-authorize`, edit(false, sibling.id));
    expect((await request(test.owner, "POST", "/automations", test.config)).status).toBe(403);
  });
  it("publishes the exact reviewed patch through normal MCP, HTTP and GitHub operations once", async () => {
    const test = await setup(
      { mode: "approve", allowedActions: ["redeploy", "pull_request"], readRepository: true },
      { gitOwner: "fixture", gitRepo: "app" },
    );
    const proposal = { action: "pull_request", patch };
    const run = await investigated(
      test,
      `Source inspected; proposed fix.\n\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``,
    );
    expect(run.state).toBe("approval");
    expect(run.proposal).not.toContain("src/app.ts");
    expect(await data(test.owner, "GET", `/automation-runs/${run.id}/proposal`)).toEqual(proposal);
    expect(
      (await request(await actor(), "GET", `/automation-runs/${run.id}/proposal`)).status,
    ).toBe(404);
    // Approval must use the persisted proposal, not a later transcript response.
    fixture.history = [{ role: "assistant", text: '```json\n{"action":"redeploy"}\n```' }];
    const transport = repositoryTransport();
    try {
      await Promise.allSettled([
        test.worker.decide(test.ctx, run.id, "approve"),
        test.worker.decide(test.ctx, run.id, "approve"),
      ]);
      const complete = (await repos.assistantAutomations.run(test.owner, run.id))!;
      expect(complete.state, complete.message).toBe("succeeded");
      expect(complete.resultUrl).toBe("https://github.com/fixture/app/pull/1");
      expect(complete.message).toContain("not yet verified");
      const writes = transport.mock.calls.map(([c]) => c).filter((c) => c.method === "POST");
      expect(writes.map((c) => new URL(c.url).pathname.split("/").at(-1))).toEqual([
        "trees",
        "commits",
        "refs",
        "pulls",
      ]);
      expect(writes[0]?.params).toMatchObject({
        base_tree: treeSha,
        tree: [
          { path: "src/app.ts", mode: "100755", content: patch.files[0]!.content },
          { path: "src/health.ts", mode: "100644", content: patch.files[1]!.content },
        ],
      });
      expect(writes[1]?.params).toMatchObject({ parents: [baseSha], tree: nextTree });
      expect(writes[2]?.params).toEqual({
        ref: `refs/heads/openship/changes/${run.id}`,
        sha: nextCommit,
      });
      expect(writes[3]?.params).toMatchObject({
        draft: true,
        maintainer_can_modify: false,
        base: "main",
      });
      const tokens = await db
        .select()
        .from(schema.personalAccessToken)
        .where(eq(schema.personalAccessToken.userId, test.owner.userId));
      const action = tokens.find((t) => t.name === `Assistant action: ${run.id}`)!;
      expect(action.revokedAt).toBeTruthy();
      const grants = await repos.patGrant.listByToken(action.id);
      expect(grants.find((g) => g.resourceType === "project")?.permissions).toEqual(["read"]);
      expect(grants.find((g) => g.resourceType === "github_repository")?.resourceId).toBe(
        "fixture/app",
      );
      await expect(test.worker.decide(test.ctx, run.id, "approve")).rejects.toThrow();
      expect(transport.mock.calls.filter(([c]) => c.url.endsWith("/git/refs"))).toHaveLength(1);
    } finally {
      transport.mockRestore();
      fixture.history = [];
      fixture.script = undefined;
    }
  });
  it("rejects code outside approved source paths before any GitHub request", async () => {
    const test = await setup({}, { gitOwner: "fixture", gitRepo: "app" });
    const connection = (await repos.assistant.connection(test.owner))!;
    await data(test.owner, "POST", `${origin}/api/tokens/mcp-authorize`, {
      mode: "edit",
      clientId: connection.clientId,
      organizationId: test.owner.organizationId,
      readOnly: false,
      fullAccess: false,
      grants: [
        { resourceType: "project", resourceId: test.project.id, permissions: ["read"] },
        {
          resourceType: "github_repository",
          resourceId: "fixture/app",
          permissions: ["write"],
          scope: { v: 1, read: { paths: ["src/**"] }, write: { paths: ["src/**"] } },
        },
      ],
    });
    await data(test.owner, "PUT", `/automations/${test.rule.id}`, {
      ...test.config,
      mode: "approve",
      allowedActions: ["commit"],
      readRepository: true,
    });
    await db
      .update(schema.deployment)
      .set({ createdAt: new Date(Date.now() + 10) })
      .where(eq(schema.deployment.id, test.deployment.id));
    const run = await investigated(
      test,
      `Unsafe location.\n\`\`\`json\n${JSON.stringify({ action: "commit", patch: { ...patch, files: [{ path: ".github/workflows/release.yml", content: "not approved" }] } })}\n\`\`\``,
    );
    const transport = repositoryTransport();
    try {
      await expect(test.worker.decide(test.ctx, run.id, "approve")).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      expect((await repos.assistantAutomations.run(test.owner, run.id))?.state).toBe("failed");
    } finally {
      transport.mockRestore();
      fixture.script = undefined;
    }
  });
  it("rejects stale base commits, symlinks, traversal, and lost permissions during publication", async () => {
    const test = await setup({}, { gitOwner: "fixture", gitRepo: "app" });
    for (const scenario of ["stale", "symlink", "traversal", "revoked"] as const) {
      const transport = repositoryTransport({
        stale: scenario === "stale",
        symlink: scenario === "symlink",
        before: async (call) => {
          if (scenario === "revoked" && call.url.endsWith("/git/trees") && call.method === "POST")
            await db
              .delete(schema.member)
              .where(
                and(
                  eq(schema.member.userId, test.owner.userId),
                  eq(schema.member.organizationId, test.owner.organizationId),
                ),
              );
        },
      });
      try {
        const response = await request(
          test.owner,
          "POST",
          `${origin}/api/github/repos/fixture/app/changes`,
          {
            requestId: randomUUID(),
            pullRequest: true,
            patch:
              scenario === "traversal"
                ? { ...patch, files: [{ path: "../private", content: "bad" }] }
                : patch,
          },
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(transport.mock.calls.some(([c]) => c.url.endsWith("/git/refs"))).toBe(false);
      } finally {
        transport.mockRestore();
      }
    }
  });
  it("never replays an accepted commit when PR creation is not confirmed", async () => {
    const test = await setup(
      { mode: "automatic", allowedActions: ["pull_request"], automaticConsent: true },
      { gitOwner: "fixture", gitRepo: "app" },
    );
    const transport = repositoryTransport({ failPr: true });
    try {
      const run = await investigated(
        test,
        `Propose fix.\n\`\`\`json\n${JSON.stringify({ action: "pull_request", patch })}\n\`\`\``,
      );
      expect(run.state).toBe("failed");
      await test.worker.sweep();
      expect(transport.mock.calls.filter(([c]) => c.url.endsWith("/git/refs"))).toHaveLength(1);
      expect((await repos.assistantAutomations.find(test.owner, test.rule.id))?.enabled).toBe(
        false,
      );
    } finally {
      transport.mockRestore();
      fixture.script = undefined;
    }
  });
  it("parses only a final validated proposal and rejects extra commands or malformed patches", () => {
    const earlier = 'Config example:\n```json\n{"timeout": 30}\n```\n';
    expect(
      parseAssistantAutomationReport(
        `${earlier}Next step.\n\`\`\`json\n${JSON.stringify({ action: "commit", patch })}\n\`\`\``,
      ).proposal,
    ).toEqual({ action: "commit", patch });
    for (const value of [
      { action: "commit", patch: { ...patch, baseSha: "main" } },
      { action: "pull_request", patch, shell: "echo bad" },
      { action: "delete" },
    ])
      expect(
        parseAssistantAutomationReport(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``).proposal,
      ).toBeUndefined();
  });
  it("runs a real scoped MCP investigation once and queues a private notification without model output", async () => {
    const test = await setup();
    await repos.notificationChannel.ensureAccountChannels(test.owner.userId);
    const channel = (await repos.notificationChannel.listByUser(test.owner.userId)).find(
      (c) => c.kind === "in_app",
    )!;
    await data(test.owner, "PUT", `/automations/${test.rule.id}`, {
      ...test.config,
      channelIds: [channel.id],
    });
    await db
      .update(schema.deployment)
      .set({ createdAt: new Date(Date.now() + 10) })
      .where(eq(schema.deployment.id, test.deployment.id));
    const foreign = await seedProject((await actor()).organizationId);
    const unselected = await seedProject(test.owner.organizationId);
    let seen = false;
    fixture.script = async function* (_run, options) {
      const listing = await rpc(options, "tools/list");
      const tool = getMcpTools().find((t) => t.method === "GET" && t.path === "/api/projects/:id")!;
      expect(listing.result.tools.some((t: { name: string }) => t.name === tool.name)).toBe(true);
      const own = await rpc(options, "tools/call", {
        name: tool.name,
        arguments: { id: test.project.id, organizationId: test.owner.organizationId },
      });
      expect(own.result.isError).not.toBe(true);
      const other = await rpc(options, "tools/call", {
        name: tool.name,
        arguments: { id: foreign.id, organizationId: test.owner.organizationId },
      });
      expect(other.result.isError).toBe(true);
      const sibling = await rpc(options, "tools/call", {
        name: tool.name,
        arguments: { id: unselected.id, organizationId: test.owner.organizationId },
      });
      expect(sibling.result.isError).toBe(true);
      expect(
        listing.result.tools.some(
          (t: { annotations?: { readOnlyHint?: boolean } }) =>
            t.annotations?.readOnlyHint === false,
        ),
      ).toBe(false);
      seen = true;
      yield {
        type: "text",
        text: 'Potential secret in evidence: SHOULD_NOT_LEAVE_OPENSHIP\n```json\n{"action":"none"}\n```',
      };
    };
    await Promise.all([
      captureAssistantAutomationEvent(test.event),
      captureAssistantAutomationEvent(test.event),
    ]);
    await Promise.all([
      test.worker.sweep(),
      createAssistantAutomations({ runtime: assistant }).sweep(),
    ]);
    const run = (await repos.assistantAutomations.runs(test.owner))[0]!;
    expect((await repos.assistantAutomations.runs(test.owner)).length).toBe(1);
    expect(run.conversationId).toBeTruthy();
    await settle(test.owner, run.conversationId!);
    expect(seen).toBe(true);
    await test.worker.sweep();
    const complete = (await repos.assistantAutomations.run(test.owner, run.id))!;
    expect(complete.state).toBe("reported");
    expect(complete.token).toBeNull();
    expect((await repos.personalAccessToken.findById(complete.tokenId!))!.revokedAt).toBeTruthy();
    const deliveries = await db
      .select()
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.organizationId, test.owner.organizationId));
    expect(deliveries).toHaveLength(1);
    expect(JSON.stringify(deliveries)).not.toContain("SHOULD_NOT_LEAVE_OPENSHIP");
    await test.worker.sweep();
    expect(
      await db
        .select()
        .from(schema.notificationDelivery)
        .where(eq(schema.notificationDelivery.organizationId, test.owner.organizationId)),
    ).toHaveLength(1);
    expect(
      (
        await request(test.owner, "POST", `/conversations/${complete.conversationId}/turns`, {
          requestId: randomUUID(),
          message: "Explain the findings",
        })
      ).status,
    ).toBe(200);
    await settle(test.owner, complete.conversationId!);
    fixture.script = undefined;
  });
  it("denies foreign apps, rules, runs and channels while allowing scoped MCP discovery", async () => {
    const test = await setup(),
      stranger = await actor();
    await connect(stranger, false);
    expect((await request(stranger, "POST", "/automations", test.config)).status).toBe(403);
    expect(
      (await request(stranger, "PUT", `/automations/${test.rule.id}`, test.config)).status,
    ).toBe(404);
    expect((await request(stranger, "DELETE", `/automations/${test.rule.id}`)).status).toBe(404);
    await repos.notificationChannel.ensureAccountChannels(stranger.userId);
    const channel = (await repos.notificationChannel.listByUser(stranger.userId))[0]!;
    expect(
      (
        await request(test.owner, "POST", "/automations", {
          ...test.config,
          channelIds: [channel.id],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(test.owner, "POST", "/automations", {
          ...test.config,
          mode: "automatic",
          action: "redeploy",
        })
      ).status,
    ).toBe(400);
    await captureAssistantAutomationEvent(test.event);
    const run = (await repos.assistantAutomations.runs(test.owner))[0]!;
    expect(
      (
        await request(stranger, "POST", `/automation-runs/${run.id}/decision`, {
          decision: "approve",
        })
      ).status,
    ).toBe(404);
    const creds = await repos.oauth.findClientToken(
      test.owner.userId,
      (await repos.assistant.connection(test.owner))!.clientId,
    );
    const bearer = await app.request(`${origin}/api/assistant/automations`, {
      headers: { authorization: `Bearer ${creds!.accessToken}` },
    });
    expect(bearer.status).toBe(200);
  });
  it("does not replay events; observes cooldown and pauses without starting another agent", async () => {
    const test = await setup();
    await investigated(test);
    const before = fixture.runs.length;
    const second = await seedDeployment(test.project, {
      status: "failed",
      createdAt: new Date(Date.now() + 20),
    });
    await captureAssistantAutomationEvent({ ...test.event, resourceId: second.id });
    await test.worker.sweep();
    expect(
      (await repos.assistantAutomations.runs(test.owner)).find((r) => r.deploymentId === second.id)
        ?.message,
    ).toContain("Cooldown");
    await data(test.owner, "PATCH", "/automation-settings", { paused: true });
    const third = await seedDeployment(test.project, {
      status: "failed",
      createdAt: new Date(Date.now() + 40),
    });
    await captureAssistantAutomationEvent({ ...test.event, resourceId: third.id });
    await test.worker.sweep();
    expect(fixture.runs.length).toBe(before);
    expect(
      (await repos.assistantAutomations.runs(test.owner)).some((r) => r.deploymentId === third.id),
    ).toBe(false);
    fixture.script = undefined;
  });
  it("cancels stale approvals after settings, membership, or deployment changes", async () => {
    for (const change of ["rule", "membership", "deployment"]) {
      const test = await setup({ mode: "approve", action: "redeploy" });
      const run = await investigated(test, 'Retry may help.\n```json\n{"action":"redeploy"}\n```');
      expect(run.state).toBe("approval");
      if (change === "rule")
        await data(test.owner, "PUT", `/automations/${test.rule.id}`, {
          ...test.config,
          enabled: false,
        });
      if (change === "membership")
        await db
          .delete(schema.member)
          .where(
            and(
              eq(schema.member.userId, test.owner.userId),
              eq(schema.member.organizationId, test.owner.organizationId),
            ),
          );
      if (change === "deployment")
        await seedDeployment(test.project, {
          status: "ready",
          createdAt: new Date(Date.now() + 100),
        });
      try {
        await test.worker.decide(test.ctx, run.id, "approve");
      } catch {
        /* access changes fail closed */
      }
      const result = (await repos.assistantAutomations.run(test.owner, run.id))!;
      expect(result.actionClaimedAt).toBeNull();
    }
    fixture.script = undefined;
  });
  it("requires a specific recommendation and consumes approval once even when the deployment response is lost", async () => {
    const test = await setup({ mode: "approve", action: "redeploy" });
    const run = await investigated(
      test,
      'Retry with the same commit.\n```json\n{"action":"redeploy"}\n```',
    );
    const dispatch = vi.fn(async () => {
      throw new Error("connection lost");
    });
    const worker = createAssistantAutomations({ runtime: assistant, dispatch });
    // A real registry descriptor is required before any action, even for the failing transport.
    const tool = getMcpTools().find((t) => t.path === "/api/deployments/:id/redeploy");
    if (!tool) {
      const { deploymentRoutes } =
        await import("../../../src/modules/deployments/deployment.routes");
      void deploymentRoutes;
      resetMcpToolCache();
    }
    await Promise.allSettled([
      worker.decide(test.ctx, run.id, "approve"),
      worker.decide(test.ctx, run.id, "approve"),
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const current = (await repos.assistantAutomations.run(test.owner, run.id))!;
    expect(current.state).toBe("failed");
    expect((await repos.assistantAutomations.find(test.owner, test.rule.id))?.enabled).toBe(false);
    await worker.sweep();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(automationRecommendation('```json\n{"action":"delete"}\n```')).toBe("none");
    expect(automationRecommendation('```json\n{"action":"restart","extra":"ignore"}\n```')).toBe(
      "none",
    );
    expect(automationRecommendation("Restart this app")).toBe("none");
    fixture.script = undefined;
  });
  it("verifies automatic actions before success and stops a failed action from triggering a loop", async () => {
    const test = await setup({ mode: "automatic", action: "redeploy", automaticConsent: true });
    const result = await seedDeployment(test.project, { status: "ready", createdAt: new Date(1) });
    const dispatch = vi.fn<typeof dispatchTool>(async () => {
      await setActive(test.project.id, result.id);
      return {
        ok: true,
        status: 200,
        data: { deployment_id: result.id, project_id: test.project.id },
        organizationId: test.owner.organizationId,
      };
    });
    let healthy = false;
    test.worker = createAssistantAutomations({
      runtime: assistant,
      dispatch,
      verify: async () => healthy,
    });
    const run = await investigated(
      test,
      'A retry is appropriate.\n```json\n{"action":"redeploy"}\n```',
    );
    expect(run.state).toBe("verifying");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      organizationId: test.owner.organizationId,
      id: test.deployment.id,
      body: { useExistingCommit: true },
    });
    await test.worker.sweep();
    expect((await repos.assistantAutomations.run(test.owner, run.id))?.state).toBe("verifying");
    healthy = true;
    await test.worker.sweep();
    expect((await repos.assistantAutomations.run(test.owner, run.id))?.state).toBe("succeeded");
    expect(dispatch).toHaveBeenCalledTimes(1);
    fixture.script = undefined;
  });
  it("uses the normal HTTP deployment route with a single-app write grant and excludes concurrent workers", async () => {
    const test = await setup({ mode: "approve", action: "redeploy" });
    const run = await investigated(
      test,
      'Retry the current commit.\n```json\n{"action":"redeploy"}\n```',
    );
    const engine = await import("@repo/platform/engine/modules/deployments/build.service");
    const { assertGitHubRepoAccess } =
      await import("@repo/platform/engine/modules/github/github-access");
    await db
      .update(schema.project)
      .set({ gitOwner: "automation-fixture", gitRepo: "private-app" })
      .where(eq(schema.project.id, test.project.id));
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const result = await seedDeployment(test.project, { status: "ready", createdAt: new Date(1) });
    const redeploy = vi
      .spyOn(engine, "redeployBuildSession")
      .mockImplementation(async (ctx, id, options) => {
        expect(ctx.organizationId).toBe(test.owner.organizationId);
        await assertGitHubRepoAccess(ctx, { owner: "automation-fixture", repo: "private-app" });
        await expect(
          assertGitHubRepoAccess(ctx, { owner: "automation-fixture", repo: "another-app" }),
        ).rejects.toThrow();
        expect(id).toBe(test.deployment.id);
        expect(options).toMatchObject({ useExistingCommit: true });
        enter();
        await gate;
        return { deployment_id: result.id, project_id: test.project.id };
      });
    try {
      const worker = createAssistantAutomations({
        runtime: assistant,
        dispatch: async (...args) => {
          const response = await dispatchTool(...args);
          expect(response.ok, JSON.stringify(response.data)).toBe(true);
          return response;
        },
      });
      const applying = worker.decide(test.ctx, run.id, "approve");
      await Promise.race([
        entered,
        applying.then(() => {
          throw new Error("Action ended before reaching the deployment engine");
        }),
      ]);
      await expect(test.worker.decide(test.ctx, run.id, "approve")).rejects.toThrow();
      await createAssistantAutomations({ runtime: assistant }).sweep();
      expect((await repos.assistantAutomations.run(test.owner, run.id))?.state).toBe("applying");
      expect(redeploy).toHaveBeenCalledTimes(1);
      release();
      await applying;
      expect((await repos.assistantAutomations.run(test.owner, run.id))?.state).toBe("verifying");
      const tokens = await db
        .select()
        .from(schema.personalAccessToken)
        .where(eq(schema.personalAccessToken.userId, test.owner.userId));
      const action = tokens.find((t) => t.name === `Assistant action: ${run.id}`)!;
      expect(action.revokedAt).toBeTruthy();
      const grants = await repos.patGrant.listByToken(action.id);
      expect(grants).toHaveLength(2);
      expect(grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resourceId: test.project.id,
            permissions: ["read", "deployments:trigger"],
          }),
          expect.objectContaining({
            resourceId: "automation-fixture/private-app",
            permissions: ["read"],
          }),
        ]),
      );
    } finally {
      release();
      redeploy.mockRestore();
      fixture.script = undefined;
    }
  });
  it("cancels an investigation immediately on pause and does not replay events from the pause", async () => {
    const test = await setup();
    await captureAssistantAutomationEvent(test.event);
    await test.worker.sweep();
    const run = (await repos.assistantAutomations.runs(test.owner))[0]!;
    await test.worker.pause(test.ctx, true);
    expect((await repos.assistantAutomations.run(test.owner, run.id))?.state).toBe("cancelled");
    expect((await repos.personalAccessToken.findById(run.tokenId!))?.revokedAt).toBeTruthy();
    const whilePaused = await seedDeployment(test.project, { status: "failed" });
    await test.worker.pause(test.ctx, false);
    await test.worker.sweep();
    expect(
      (await repos.assistantAutomations.runs(test.owner)).some(
        (r) => r.deploymentId === whilePaused.id,
      ),
    ).toBe(false);
    expect(
      (
        await request(test.owner, "POST", `/conversations/${run.conversationId}/respond`, {
          interactionId: "test",
          requestId: randomUUID(),
          answers: {},
        })
      ).status,
    ).toBe(403);
  });
  it("deduplicates health escalation and skips recovery, stopped apps and old incidents", async () => {
    const test = await setup({ trigger: "service.unhealthy", mode: "approve", action: "restart" });
    await setActive(test.project.id, test.deployment.id);
    const incident = {
      id: randomUUID(),
      organizationId: test.owner.organizationId,
      projectId: test.project.id,
      deploymentId: test.deployment.id,
      serviceKey: "web",
      serviceName: "Web",
      kind: "unhealthy" as const,
      openedAt: new Date(Date.now() + 10),
      confirmations: 2,
    };
    await db.insert(schema.serviceIncident).values(incident);
    const event = {
      organizationId: test.owner.organizationId,
      eventType: "service.unhealthy",
      payload: { incidentId: incident.id },
    };
    await Promise.all([
      captureAssistantAutomationEvent(event),
      captureAssistantAutomationEvent({ ...event, eventType: "service.down" }),
    ]);
    expect(await repos.assistantAutomations.runs(test.owner)).toHaveLength(1);
    await db
      .update(schema.serviceIncident)
      .set({ status: "resolved" })
      .where(eq(schema.serviceIncident.id, incident.id));
    await test.worker.sweep();
    expect((await repos.assistantAutomations.runs(test.owner))[0]?.state).toBe("skipped");
    const oldId = randomUUID();
    await db
      .insert(schema.serviceIncident)
      .values({ ...incident, id: oldId, serviceKey: "old", openedAt: new Date(1) });
    await captureAssistantAutomationEvent({ ...event, payload: { incidentId: oldId } });
    await db
      .update(schema.project)
      .set({ disabledAt: new Date() })
      .where(eq(schema.project.id, test.project.id));
    const stoppedId = randomUUID();
    await db
      .insert(schema.serviceIncident)
      .values({ ...incident, id: stoppedId, serviceKey: "stopped" });
    await captureAssistantAutomationEvent({ ...event, payload: { incidentId: stoppedId } });
    expect(await repos.assistantAutomations.runs(test.owner)).toHaveLength(1);
  });
  it("fails closed for Cloud control-plane hosting and a changed assistant grant", async () => {
    const test = await setup();
    await captureAssistantAutomationEvent(test.event);
    const previous = env.CLOUD_MODE;
    try {
      env.CLOUD_MODE = true;
      await test.worker.sweep();
      const run = (await repos.assistantAutomations.runs(test.owner))[0]!;
      expect(run.state).toBe("failed");
      expect(run.conversationId).toBeNull();
    } finally {
      env.CLOUD_MODE = previous;
    }
    const other = await setup({ mode: "approve", action: "redeploy" });
    const run = await investigated(other, 'Retry.\n```json\n{"action":"redeploy"}\n```');
    const connection = (await repos.assistant.connection(other.owner))!;
    const binding = (await repos.personalAccessToken.findOAuthBinding(
      other.owner.userId,
      connection.clientId,
    ))!;
    await db
      .update(schema.personalAccessToken)
      .set({ readOnly: !binding.readOnly })
      .where(eq(schema.personalAccessToken.id, binding.id));
    await expect(other.worker.decide(other.ctx, run.id, "approve")).rejects.toThrow(
      "permissions changed",
    );
    expect((await repos.assistantAutomations.run(other.owner, run.id))?.actionClaimedAt).toBeNull();
    fixture.script = undefined;
  });
  it("enforces the daily budget and expired approvals, and preserves the original run details", async () => {
    const test = await setup({ dailyLimit: 1 });
    const original = await investigated(test);
    await db
      .update(schema.assistantAutomation)
      .set({ lastStartedAt: new Date(1) })
      .where(eq(schema.assistantAutomation.id, test.rule.id));
    const next = await seedDeployment(test.project, {
      status: "failed",
      createdAt: new Date(Date.now() + 10),
    });
    await captureAssistantAutomationEvent({ ...test.event, resourceId: next.id });
    await test.worker.sweep();
    expect(
      (await repos.assistantAutomations.runs(test.owner)).find((r) => r.deploymentId === next.id)
        ?.message,
    ).toContain("Daily");
    await test.worker.save(
      test.ctx,
      { ...test.config, name: "Changed flow", enabled: false },
      test.rule.id,
    );
    expect(
      (await test.worker.overview(test.ctx)).runs.find((r) => r.id === original.id)?.name,
    ).toBe(test.config.name);
    const approval = await setup({ mode: "approve", action: "redeploy" });
    const run = await investigated(approval, 'Retry.\n```json\n{"action":"redeploy"}\n```');
    await repos.assistantAutomations.update(approval.owner, run.id, { expiresAt: new Date(1) });
    await expect(approval.worker.decide(approval.ctx, run.id, "approve")).rejects.toThrow();
    await approval.worker.sweep();
    expect((await repos.assistantAutomations.run(approval.owner, run.id))?.state).toBe("failed");
    expect(
      (await repos.assistantAutomations.run(approval.owner, run.id))?.actionClaimedAt,
    ).toBeNull();
    fixture.script = undefined;
  });
  it("pauses after failed verification instead of generating an automatic repair loop", async () => {
    const test = await setup({ mode: "automatic", action: "redeploy", automaticConsent: true });
    const result = await seedDeployment(test.project, { status: "ready", createdAt: new Date(1) });
    const dispatch = vi.fn<typeof dispatchTool>(async () => ({
      ok: true,
      status: 200,
      data: { deployment_id: result.id, project_id: test.project.id },
      organizationId: test.owner.organizationId,
    }));
    test.worker = createAssistantAutomations({
      runtime: assistant,
      dispatch,
      verify: async () => {
        throw new Error("unhealthy test workload");
      },
    });
    const run = await investigated(test, 'Retry.\n```json\n{"action":"redeploy"}\n```');
    await test.worker.sweep();
    expect((await repos.assistantAutomations.run(test.owner, run.id))?.state).toBe("failed");
    expect((await repos.assistantAutomations.find(test.owner, test.rule.id))?.enabled).toBe(false);
    const another = await seedDeployment(test.project, {
      status: "failed",
      createdAt: new Date(Date.now() + 10),
    });
    await captureAssistantAutomationEvent({ ...test.event, resourceId: another.id });
    await test.worker.sweep();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await repos.assistantAutomations.runs(test.owner)).toHaveLength(1);
    fixture.script = undefined;
  });
});

describe("Assistant image turns and model selection", () => {
  const image = {
    name: "status.png",
    mime: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  };
  it("passes images and the selected model through the same scoped turn, saves the model, and binds retries to both", async () => {
    const owner = await actor();
    await connect(owner);
    const created = await chat(owner);
    const before = fixture.runs.length;
    const input = {
      requestId: randomUUID(),
      message: "",
      model: "test-model-a",
      attachments: [image],
    };
    const first = await data(owner, "POST", `/conversations/${created.id}/turns`, input);
    expect(first.events[0].user.attachments).toEqual([image]);
    expect(fixture.runs.at(-1).options).toMatchObject({
      message: "",
      options: {
        settings: { model: "test-model-a", sandbox: "read-only", permissionMode: "never" },
        attachments: [{ artifactId: expect.any(String), name: image.name, mime: image.mime }],
      },
    });
    await settle(owner, created.id);
    const modelA = await data(owner, "GET", `/conversations/${created.id}`);
    expect(modelA.conversation.model).toBe("test-model-a");
    await data(owner, "POST", `/conversations/${created.id}/turns`, input);
    expect(fixture.runs.length).toBe(before + 1);
    for (const changed of [
      { ...input, model: "test-model-b" },
      { ...input, attachments: [{ ...image, name: "different.png" }] },
    ])
      expect(
        (await request(owner, "POST", `/conversations/${created.id}/turns`, changed)).status,
      ).toBe(409);
    const other = await actor();
    expect(
      (
        await request(other, "POST", `/conversations/${created.id}/turns`, {
          ...input,
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(404);
    await data(owner, "POST", `/conversations/${created.id}/turns`, {
      requestId: randomUUID(),
      message: "Continue",
      model: "test-model-b",
    });
    expect(fixture.runs.at(-1).options.options.settings.model).toBe("test-model-b");
    await settle(owner, created.id);
    expect((await data(owner, "GET", `/conversations/${created.id}`)).conversation.model).toBe(
      "test-model-b",
    );
    await data(owner, "POST", `/conversations/${created.id}/turns`, {
      requestId: randomUUID(),
      message: "Continue again",
    });
    expect(fixture.runs.at(-1).options.options.settings.model).toBe("test-model-b");
    await settle(owner, created.id);
  });
  it("rejects paths, URLs, spoofed image bytes, empty messages and unsupported image inputs before starting an agent", async () => {
    const owner = await actor();
    await connect(owner);
    const created = await chat(owner),
      before = fixture.runs.length;
    const base = { requestId: randomUUID(), message: "Inspect" };
    for (const attachments of [
      [{ ...image, path: "/private/secret" }],
      [{ ...image, artifactId: "someone-elses-image" }],
      [{ ...image, data: "https://example.com/image.png" }],
      [{ ...image, data: Buffer.from("<svg onload='alert(1)'></svg>").toString("base64") }],
      [{ ...image, mime: "image/svg+xml" }],
      [{ ...image, name: "../secret.png" }],
      Array(5).fill(image),
    ])
      expect(
        (
          await request(owner, "POST", `/conversations/${created.id}/turns`, {
            ...base,
            attachments,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await request(owner, "POST", `/conversations/${created.id}/turns`, {
          ...base,
          message: "  ",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(owner, "POST", `/conversations/${created.id}/turns`, {
          ...base,
          model: "unavailable-model",
        })
      ).status,
    ).toBe(400);
    fixture.imageInput = false;
    try {
      expect(
        (
          await request(owner, "POST", `/conversations/${created.id}/turns`, {
            ...base,
            attachments: [image],
          })
        ).status,
      ).toBe(400);
    } finally {
      fixture.imageInput = true;
    }
    expect(fixture.runs.length).toBe(before);
  });
});

describe("Scoped agents: shared API, MCP, native bots and task conversations", () => {
  async function specialist() {
    const owner = await actor();
    const connection = await connect(owner, false);
    const project = await seedProject(owner.organizationId, { name: "Specialist app" });
    const input = {
      requestId: randomUUID(),
      name: "Production investigator",
      icon: "shield-check",
      purpose: "Trace this app's failures",
      instructions: "Inspect evidence before suggesting a fix.",
      provider: "codex",
      model: "test-model-a",
      readOnly: true,
      grants: [{ resourceType: "project", resourceId: project.id, permissions: ["read"] }],
    };
    const agent = await data(owner, "POST", "/agents", input);
    return { owner, connection, project, input, agent };
  }
  async function tool(owner: Actor, method: string, path: string, args: Record<string, unknown>) {
    const connection = (await repos.assistant.connection(owner))!;
    const token = (await repos.oauth.findClientToken(owner.userId, connection.clientId))!;
    const definition = getMcpTools().find(
      (t) => t.method === method && t.path.replace(/\/$/, "") === path,
    )!;
    expect(definition, path).toBeTruthy();
    return dispatchTool(
      definition,
      { organizationId: owner.organizationId, ...args },
      token.accessToken,
      {
        principalId: `oauth:${connection.clientId}`,
        clientIp: null,
        userAgent: "agent-integration",
      },
    );
  }
  it("creates through MCP, reuses the API and never exposes private connection controls", async () => {
    const test = await specialist();
    const result = await tool(test.owner, "POST", "/api/assistant/agents", { body: test.input });
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    expect((result.data as any).data.id).toBe(test.agent.id);
    expect((result.data as any).data.icon).toBe("shield-check");
    expect((await data(test.owner, "GET", `/agents/${test.agent.id}`)).icon).toBe("shield-check");
    expect(await repos.assistantAgents.list(test.owner)).toHaveLength(1);
    expect(fixture.bots.get(test.agent.id)).toMatchObject({
      externalTools: true,
      instructions: test.input.instructions,
      notificationsMuted: true,
    });
    expect(getMcpTools().some((t) => t.path === "/api/assistant/automations")).toBe(true);
    expect(
      getMcpTools().filter((t) =>
        /\/api\/assistant\/(providers|enable|custom-api|conversations)/.test(t.path),
      ),
    ).toEqual([]);
    expect(
      (await request(test.owner, "POST", "/agents", { ...test.input, name: "Different identity" }))
        .status,
    ).toBe(409);
    const other = await actor();
    await connect(other, false);
    expect(await data(other, "GET", "/agents")).toEqual([]);
    expect((await request(other, "GET", `/agents/${test.agent.id}`)).status).toBe(404);
    expect(
      (
        await request(other, "POST", `/agents/${test.agent.id}/tasks`, {
          message: "Read it",
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(404);
  });
  it("persists a bot icon through the shared API and rejects arbitrary artwork", async () => {
    const test = await specialist();
    const chat = await data(test.owner, "POST", "/conversations", {
      agentId: test.agent.id,
      provider: "codex",
    });
    const nativeRevision = fixture.bots.get(test.agent.id)!.revision;
    expect(
      (await request(test.owner, "POST", "/agents", { ...test.input, icon: "rocket" })).status,
    ).toBe(409);
    for (const icon of ["https://example.com/avatar.svg", "../private", "<svg onload=alert(1)>"])
      expect(
        (
          await request(test.owner, "PUT", `/agents/${test.agent.id}`, {
            ...test.input,
            requestId: undefined,
            revision: test.agent.revision,
            icon,
          })
        ).status,
      ).toBe(400);
    const { requestId, ...config } = test.input;
    const updated = await data(test.owner, "PUT", `/agents/${test.agent.id}`, {
      ...config,
      revision: test.agent.revision,
      icon: "rocket",
    });
    expect(updated.icon).toBe("rocket");
    expect(updated.revision).toBe(test.agent.revision);
    expect(fixture.bots.get(test.agent.id)!.revision).toBe(nativeRevision);
    expect((await data(test.owner, "GET", `/conversations/${chat.id}`)).accessChanged).toBeFalsy();
    expect((await repos.assistantAgents.find(test.owner, test.agent.id))?.icon).toBe("rocket");
    const other = await actor();
    await connect(other, false);
    expect(
      (
        await request(other, "PUT", `/agents/${test.agent.id}`, {
          ...config,
          revision: updated.revision,
          icon: "bot",
        })
      ).status,
    ).toBe(403);
  });
  it("opens a blank specialist chat through the normal conversation API without starting work", async () => {
    const test = await specialist();
    const before = fixture.runs.length;
    const chat = await data(test.owner, "POST", "/conversations", {
      agentId: test.agent.id,
      provider: "claude",
      model: "ignored",
    });
    expect(chat.agentId).toBe(test.agent.id);
    expect(chat.provider).toBe(test.input.provider);
    expect(chat.model).toBe(test.input.model);
    expect(fixture.runs.length).toBe(before);
    const snapshot = await data(test.owner, "GET", `/conversations/${chat.id}`);
    expect(snapshot.messages).toEqual([]);
    const other = await actor();
    await connect(other, false);
    expect(
      (
        await request(other, "POST", "/conversations", {
          agentId: test.agent.id,
          provider: "codex",
        })
      ).status,
    ).toBe(404);
  });
  it("rejects broad, foreign and elevated scopes before creating a native bot", async () => {
    const test = await specialist();
    const other = await actor();
    const foreign = await seedProject(other.organizationId);
    for (const grants of [
      [{ resourceType: "project", resourceId: "*", permissions: ["read"] }],
      [{ resourceType: "settings", resourceId: "*", permissions: ["admin"] }],
      [{ resourceType: "project", resourceId: foreign.id, permissions: ["read"] }],
    ]) {
      const before = fixture.bots.size;
      const response = await request(test.owner, "POST", "/agents", {
        ...test.input,
        requestId: randomUUID(),
        grants,
      });
      expect([400, 403]).toContain(response.status);
      expect(fixture.bots.size).toBe(before);
    }
    await data(test.owner, "POST", `${origin}/api/tokens/mcp-authorize`, {
      mode: "edit",
      clientId: test.connection.clientId,
      organizationId: test.owner.organizationId,
      fullAccess: false,
      readOnly: true,
      grants: test.input.grants,
    });
    expect(
      (
        await request(test.owner, "POST", "/agents", {
          ...test.input,
          requestId: randomUUID(),
          readOnly: false,
        })
      ).status,
    ).toBe(403);
    const newScope = [{ ...test.input.grants[0], permissions: ["write"] }];
    expect(
      (
        await request(test.owner, "POST", "/agents", {
          ...test.input,
          requestId: randomUUID(),
          grants: newScope,
        })
      ).status,
    ).toBe(403);
    fixture.botVersion = 8;
    try {
      expect(
        (await request(test.owner, "POST", "/agents", { ...test.input, requestId: randomUUID() }))
          .status,
      ).toBe(409);
      expect(await repos.assistantAgents.list(test.owner)).toHaveLength(1);
    } finally {
      fixture.botVersion = 9;
    }
  });
  it("uses a specialist's narrower source paths in automations without inheriting the parent's repository access", async () => {
    const test = await specialist();
    await db
      .update(schema.project)
      .set({ gitOwner: "fixture", gitRepo: "app" })
      .where(eq(schema.project.id, test.project.id));
    const { requestId: _, ...config } = test.input;
    await data(test.owner, "PUT", `/agents/${test.agent.id}`, {
      ...config,
      revision: test.agent.revision,
      grants: [
        ...config.grants,
        {
          resourceType: "github_repository",
          resourceId: "fixture/app",
          permissions: ["read"],
          scope: { v: 1, read: { paths: ["src/**"] } },
        },
      ],
    });
    const permissions = await data(
      test.owner,
      "GET",
      `/automation-permissions/${test.project.id}?agentId=${test.agent.id}`,
    );
    expect(permissions.source.allowed).toBe(true);
    expect(permissions.actions.find((a: any) => a.id === "pull_request").allowed).toBe(false);
    const { automationGrants } = await import("../../../src/modules/assistant/automation-access");
    const agent = (await repos.assistantAgents.find(test.owner, test.agent.id))!;
    const ctx = await resolveExecutionAuthority(agent.authority, "scoped-repository-test");
    const grants = await automationGrants(ctx, test.project.id, [], true, test.agent.id);
    expect(grants.find((g) => g.resourceType === "github_repository")?.scope).toEqual({
      v: 1,
      read: { paths: ["src/**"] },
    });
  });
  it("runs one task with one native chat and least-privilege MCP, then revokes its temporary token", async () => {
    const test = await specialist();
    const sibling = await seedProject(test.owner.organizationId, { name: "Private sibling" });
    let read: any, foreign: any, write: any, recursive: any;
    fixture.script = async function* (_run, options) {
      read = await rpc(options, "tools/call", {
        name: "get_projects_by_id",
        arguments: { id: test.project.id },
      });
      foreign = await rpc(options, "tools/call", {
        name: "get_projects_by_id",
        arguments: { id: sibling.id },
      });
      write = await rpc(options, "tools/call", {
        name: "patch_projects_by_id",
        arguments: { id: test.project.id, body: { name: "Not allowed" } },
      });
      recursive = await rpc(options, "tools/call", {
        name: getMcpTools().find(
          (t) => t.path.replace(/\/$/, "") === "/api/assistant/agents" && t.method === "POST",
        )!.name,
        arguments: { body: { ...test.input, requestId: randomUUID() } },
      });
      yield { type: "text", text: "Scoped evidence reviewed." };
    };
    try {
      const input = { requestId: randomUUID(), message: "Inspect this app" };
      const [first, retry] = await Promise.all([
        data(test.owner, "POST", `/agents/${test.agent.id}/tasks`, input),
        data(test.owner, "POST", `/agents/${test.agent.id}/tasks`, input),
      ]);
      expect(first.conversation.id).toBe(retry.conversation.id);
      const completed = await settle(test.owner, first.conversation.id);
      expect(completed.activity.state).toBe("done");
      expect(read.result.isError).not.toBe(true);
      expect(foreign.result.isError).toBe(true);
      expect(write.error || write.result?.isError).toBeTruthy();
      expect(recursive.error || recursive.result?.isError).toBeTruthy();
      const row = (await repos.assistant.find(test.owner, first.conversation.id))!;
      expect(fixture.botChats.get(row.nativeChatId)).toBe(test.agent.id);
      expect(fixture.runs.filter((r) => r.chatId === row.nativeChatId)).toHaveLength(1);
      expect(row.executionToken).toBeNull();
      expect(row.executionTokenId).toBeNull();
      const token = (
        await db
          .select()
          .from(schema.personalAccessToken)
          .where(eq(schema.personalAccessToken.name, `Assistant task: ${row.id}`))
      )[0]!;
      expect(token.readOnly).toBe(true);
      expect(token.scoped).toBe(true);
      expect(token.revokedAt).not.toBeNull();
      expect(token.expiresAt!.getTime() - token.createdAt.getTime()).toBeLessThanOrEqual(600001);
      const inspection = await tool(test.owner, "GET", "/api/assistant/agents/:id/tasks/:chatId", {
        id: test.agent.id,
        chatId: row.id,
      });
      expect(inspection.status).toBe(200);
      expect(JSON.stringify(inspection.data)).toContain("Scoped evidence reviewed");
      expect(JSON.stringify(inspection.data)).not.toContain("executionToken");
      expect(
        (
          await request(test.owner, "POST", `/agents/${test.agent.id}/tasks`, {
            ...input,
            message: "A different task",
          })
        ).status,
      ).toBe(409);
    } finally {
      fixture.script = undefined;
    }
  });
  it("steers a running task once, preserves the conversation, and does not replay an acknowledged input", async () => {
    const test = await specialist();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.script = async function* (run) {
      run.release = release;
      yield { type: "text", text: "Looking into it." };
      await held;
    };
    try {
      const task = await data(test.owner, "POST", `/agents/${test.agent.id}/tasks`, {
        requestId: randomUUID(),
        message: "Investigate",
      });
      const row = (await repos.assistant.find(test.owner, task.conversation.id))!;
      const run = fixture.runs.find((r) => r.chatId === row.nativeChatId)!;
      const followup = { requestId: randomUUID(), message: "Also check the previous release." };
      await Promise.all([
        data(test.owner, "POST", `/agents/${test.agent.id}/tasks/${row.id}/messages`, followup),
        data(test.owner, "POST", `/agents/${test.agent.id}/tasks/${row.id}/messages`, followup),
      ]);
      expect(run.inputs.map((i: any) => i.text)).toEqual([followup.message]);
      release();
      await settle(test.owner, row.id);
      await data(test.owner, "POST", `/agents/${test.agent.id}/tasks/${row.id}/messages`, followup);
      expect(fixture.runs.filter((r) => r.chatId === row.nativeChatId)).toHaveLength(1);
      expect(
        (
          await request(test.owner, "POST", `/agents/${test.agent.id}/tasks/${row.id}/messages`, {
            ...followup,
            message: "Reused ID",
          })
        ).status,
      ).toBe(409);
      fixture.script = undefined;
      await data(test.owner, "POST", `/agents/${test.agent.id}/tasks/${row.id}/messages`, {
        requestId: randomUUID(),
        message: "Summarize the evidence.",
      });
      await settle(test.owner, row.id);
      expect(fixture.runs.filter((r) => r.chatId === row.nativeChatId)).toHaveLength(2);
      expect((await data(test.owner, "GET", `/agents/${test.agent.id}`)).tasks).toHaveLength(1);
    } finally {
      release();
      fixture.script = undefined;
    }
  });
  it("invalidates old tasks on a scope edit and retains history when archived", async () => {
    const test = await specialist();
    const task = await data(test.owner, "POST", `/agents/${test.agent.id}/tasks`, {
      requestId: randomUUID(),
      message: "Investigate",
    });
    await settle(test.owner, task.conversation.id);
    const { requestId: _, ...config } = test.input;
    const edited = await data(test.owner, "PUT", `/agents/${test.agent.id}`, {
      ...config,
      revision: test.agent.revision,
      instructions: "Report exact evidence.",
    });
    expect(edited.revision).toBe(2);
    const older = await tool(test.owner, "GET", "/api/assistant/agents/:id/tasks/:chatId", {
      id: test.agent.id,
      chatId: task.conversation.id,
    });
    expect(older.status).toBe(403);
    const listed = await tool(test.owner, "GET", "/api/assistant/agents/:id", {
      id: test.agent.id,
    });
    expect((listed.data as any).data.tasks).toEqual([]);
    expect(
      (await request(test.owner, "PUT", `/agents/${test.agent.id}`, { ...config, revision: 1 }))
        .status,
    ).toBe(409);
    expect(
      (
        await request(
          test.owner,
          "POST",
          `/agents/${test.agent.id}/tasks/${task.conversation.id}/messages`,
          { requestId: randomUUID(), message: "Continue" },
        )
      ).status,
    ).toBe(409);
    await data(test.owner, "POST", `/agents/${test.agent.id}/archive`, {
      revision: edited.revision,
    });
    expect((await data(test.owner, "GET", `/agents/${test.agent.id}`)).tasks).toHaveLength(1);
    expect(
      (
        await request(test.owner, "POST", `/agents/${test.agent.id}/tasks`, {
          requestId: randomUUID(),
          message: "Should not run",
        })
      ).status,
    ).toBe(409);
  });
  it("revokes active task credentials and pauses attached flows atomically on an agent edit", async () => {
    const test = await specialist();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.script = async function* (run) {
      run.release = release;
      yield { type: "text", text: "Reading the incident." };
      await held;
    };
    const worker = createAssistantAutomations({ runtime: assistant });
    try {
      const task = await data(test.owner, "POST", `/agents/${test.agent.id}/tasks`, {
        requestId: randomUUID(),
        message: "Inspect this app",
      });
      const chat = (await repos.assistant.find(test.owner, task.conversation.id))!;
      const flow = await data(test.owner, "POST", "/automations", {
        agentId: test.agent.id,
        name: "Incident investigator",
        projectId: test.project.id,
        trigger: "deployment.failed",
        provider: "codex",
        model: "",
        mode: "report",
        action: "none",
        instructions: "",
        channelIds: [],
        cooldownMinutes: 30,
        dailyLimit: 5,
        enabled: true,
        automaticConsent: false,
      });
      const deployment = await seedDeployment(test.project, {
        status: "failed",
        createdAt: new Date(Date.now() + 10),
      });
      await captureAssistantAutomationEvent({
        organizationId: test.owner.organizationId,
        eventType: "deployment.failed",
        resourceType: "deployment",
        resourceId: deployment.id,
      });
      await worker.sweep();
      const run = (await repos.assistantAutomations.runs(test.owner))[0]!;
      expect(run.state).toBe("investigating");
      expect(run.tokenId).toBeTruthy();
      expect(chat.executionTokenId).toBeTruthy();
      const { decrypt } = await import("@repo/platform/engine/lib/encryption");
      const credential = decrypt(chat.executionToken!);
      const read = () =>
        app.request(`${origin}/api/projects/${test.project.id}`, {
          headers: {
            Authorization: `Bearer ${credential}`,
            "X-Organization-Id": test.owner.organizationId,
          },
        });
      expect((await read()).status).toBe(200);
      const { requestId: _, ...config } = test.input;
      await data(test.owner, "PUT", `/agents/${test.agent.id}`, {
        ...config,
        revision: test.agent.revision,
        instructions: "Use the updated investigation instructions.",
      });
      expect((await read()).status).toBe(401);
      expect(
        (await repos.personalAccessToken.findById(chat.executionTokenId!))!.revokedAt,
      ).not.toBeNull();
      expect((await repos.personalAccessToken.findById(run.tokenId!))!.revokedAt).not.toBeNull();
      expect((await repos.assistantAutomations.find(test.owner, flow.id))!.enabled).toBe(false);
      expect((await repos.assistantAutomations.run(test.owner, run.id))!.state).toBe("cancelled");
      // A delayed mint cannot reattach the old access after the edit commits.
      expect(
        await repos.assistant.executionToken(test.owner, chat.id, {
          executionTokenId: chat.executionTokenId,
          executionToken: chat.executionToken,
        }),
      ).toBeUndefined();
      expect(
        await repos.assistantAutomations.executionToken(run, {
          tokenId: run.tokenId!,
          token: run.token!,
        }),
      ).toBeUndefined();
      expect((await data(test.owner, "GET", `/agents/${test.agent.id}`)).tasks).toHaveLength(2);
    } finally {
      release();
      fixture.script = undefined;
    }
  });
  it("uses the same agent in an event-driven automation and keeps follow-up access read-only", async () => {
    const test = await specialist();
    const config: AssistantAutomationConfig = {
      agentId: test.agent.id,
      name: "Trace a deployment failure",
      projectId: test.project.id,
      trigger: "deployment.failed",
      provider: "codex",
      model: "",
      mode: "report",
      action: "none",
      instructions: "",
      channelIds: [],
      cooldownMinutes: 30,
      dailyLimit: 5,
      enabled: false,
      automaticConsent: false,
    };
    const created = await tool(test.owner, "POST", "/api/assistant/automations", { body: config });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const id = (created.data as any).data.id;
    expect((created.data as any).data).toMatchObject({
      id,
      name: config.name,
      projectId: test.project.id,
      projectName: test.project.name,
      agentId: test.agent.id,
      trigger: config.trigger,
      mode: "report",
      enabled: false,
      channelIds: [],
      allowedActions: [],
    });
    expect((created.data as any).data).not.toHaveProperty("authority");
    expect((created.data as any).data).not.toHaveProperty("accessFingerprint");
    const edited = await data(test.owner, "PUT", `/automations/${id}`, {
      ...config,
      name: "Updated investigation",
    });
    expect(edited).toMatchObject({ id, name: "Updated investigation", enabled: false });
    const overview = await data(test.owner, "GET", "/automations");
    expect(overview.automations.find((flow: any) => flow.id === id)).toMatchObject({
      id,
      name: "Updated investigation",
      agentId: test.agent.id,
    });
    expect(
      (
        await tool(test.owner, "PUT", "/api/assistant/automations/:id", {
          id,
          body: { ...config, enabled: true },
        })
      ).status,
    ).toBe(403);
    const review = await data(test.owner, "POST", "/automation-activation-review", {
      automationIds: [id],
    });
    await data(test.owner, "POST", "/automation-activation", {
      automations: [{ id, revision: review.automations[0].revision }],
      automaticConsent: false,
    });
    const permissions = await data(
      test.owner,
      "GET",
      `/automation-permissions/${test.project.id}?agentId=${test.agent.id}`,
    );
    expect(permissions.read.allowed).toBe(true);
    expect(permissions.actions.every((a: any) => !a.allowed)).toBe(true);
    const deployment = await seedDeployment(test.project, {
      status: "failed",
      createdAt: new Date(Date.now() + 10),
    });
    const worker = createAssistantAutomations({ runtime: assistant });
    fixture.script = async function* () {
      yield { type: "text", text: 'Evidence reviewed.\n```json\n{"action":"none"}\n```' };
    };
    try {
      await captureAssistantAutomationEvent({
        organizationId: test.owner.organizationId,
        eventType: "deployment.failed",
        resourceType: "deployment",
        resourceId: deployment.id,
      });
      await worker.sweep();
      let run = (await repos.assistantAutomations.runs(test.owner))[0]!;
      expect(run.state, run.message).toBe("investigating");
      expect(run.conversationId).toBeTruthy();
      await settle(test.owner, run.conversationId!);
      await worker.sweep();
      run = (await repos.assistantAutomations.run(test.owner, run.id))!;
      expect(run.state, run.message).toBe("reported");
      const chat = (await repos.assistant.find(test.owner, run.conversationId!))!;
      expect(chat.agentId).toBe(test.agent.id);
      expect(fixture.botChats.get(chat.nativeChatId)).toBe(test.agent.id);
      fixture.script = undefined;
      await data(test.owner, "POST", `/agents/${test.agent.id}/tasks/${chat.id}/messages`, {
        requestId: randomUUID(),
        message: "Explain what happened.",
      });
      await settle(test.owner, chat.id);
      expect((await data(test.owner, "GET", `/agents/${test.agent.id}`)).tasks).toHaveLength(1);
    } finally {
      fixture.script = undefined;
    }
  });
});
