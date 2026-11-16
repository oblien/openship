import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Mindwire } from "mindwire";
import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import superjson from "superjson";
import { router } from "../src/trpc/trpc";
import { assistantRouter } from "../src/trpc/routes/assistant";
import { buildContext } from "../src/ctx";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { env } from "../src/env";
import { mailboxId, type MailboxCredentials } from "../src/mail/identity";
import {
  assistantState,
  askAssistant,
  configureAssistant,
  streamAssistant,
  cancelAssistant,
} from "../src/mail/assistant";
import { authenticateGrant } from "../src/mail/grants";
import { assistantTarget } from "../src/mail/assistant-targets";
import { mailMcpRoutes } from "../src/mail/mcp";
import { listJobs } from "../src/mail/outbox";
import {
  connectAssistant,
  disconnectAssistant,
  prepareAssistant,
} from "../src/mail/assistant-connections";

type Turn = Parameters<Mindwire["turn"]>[0];
const alice: MailboxCredentials = {
  email: "assistant@example.test",
  password: "test-only",
  imapHost: "mail.example.test",
  imapPort: 993,
  smtpHost: "mail.example.test",
  smtpPort: 587,
};
const bob = { ...alice, email: "other@example.test" };
const hostToken = "mail-fixture-host-token-only";

// Exercise the installed SDK over HTTP/SSE. Only the remote daemon/LLM is a fixture;
// mailbox authorization, MCP transport, persistence and the assistant controller are real.
function runtimeFixture() {
  const state = {
    configured: true,
    authenticated: true,
    savedKey: "",
    providers: {} as Record<string, { name: string; hasKey: boolean; models: string[] }>,
    authError: false,
    logoutError: false,
    setupRunning: false,
    onAuthStep: async () => {},
    botsVersion: 9,
    requests: [] as string[],
    turns: [] as Turn[],
    projects: [] as { id: string; path: string }[],
    bots: [] as { id: string; projectId: string; externalTools: boolean }[],
    deleted: [] as string[],
    cancelled: [] as string[],
    onHealth: async () => {},
    onTurn: async (_turn: Turn) => {},
    events: [
      { type: "text", itemId: "answer", text: "Hello", delta: false },
      { type: "text", itemId: "answer", text: " there", delta: true },
      { type: "result", result: { text: "Hello there" } },
    ] as unknown[],
  };
  const runs = new Map<string, { id: string; chatId: string; status: string }>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${hostToken}`)
        return new Response("", { status: 401 });
      const url = new URL(request.url);
      const path = url.pathname;
      state.requests.push(`${request.method} ${path}`);
      if (path === "/healthz") {
        await state.onHealth();
        return Response.json({ ok: true, botsVersion: state.botsVersion });
      }
      if (path === "/agent")
        return Response.json({
          configured: state.configured,
          authStatus: { configured: state.configured && state.authenticated },
          capabilities: {
            mcpServers: true,
            systemPrompt: true,
            claudeSettings: true,
            customProviders: true,
          },
        });
      if (path === "/auth/methods")
        return Response.json([{ id: "apiKey", fields: [{ key: "apiKey", type: "secret" }] }]);
      if (path === "/setup") {
        if (request.method === "POST") state.setupRunning = true;
        return Response.json({
          started: true,
          running: state.setupRunning,
          ok: state.configured,
          steps: [],
        });
      }
      if (path === "/auth/begin") return Response.json({ method: "apiKey", status: "needs_input" });
      if (path === "/auth/step") {
        const input = await request.json();
        state.savedKey = input.apiKey;
        await state.onAuthStep();
        if (state.authError) return Response.json({ message: input.apiKey }, { status: 500 });
        state.authenticated = true;
        return Response.json({ method: "apiKey", status: "complete" });
      }
      if (path === "/auth/logout") {
        if (state.logoutError) return new Response("Unavailable", { status: 503 });
        state.savedKey = "";
        state.authenticated = false;
        return Response.json({ configured: false, signedOut: true });
      }
      if (path.startsWith("/providers/")) {
        const id = path.split("/").at(-1)!;
        if (request.method === "PUT") {
          const body = await request.json();
          state.savedKey = body.apiKey;
          state.providers[id] = { ...body, hasKey: !!body.apiKey };
        }
        if (request.method === "DELETE") {
          delete state.providers[id];
          state.savedKey = "";
          return Response.json({});
        }
        return Response.json(state.providers[id]);
      }
      if (path === "/workspace") return Response.json({ projects: state.projects });
      if (path.startsWith("/workspace/projects/")) {
        const { record } = await request.json();
        state.projects.push({ ...record, id: path.split("/").at(-1) });
        return Response.json({});
      }
      if (path === "/workspace/agents/ensure") return Response.json({ agentId: "fixture-agent" });
      if (path === "/bots") {
        if (request.method === "GET") return Response.json(state.bots);
        const bot = await request.json();
        state.bots.push(bot);
        return Response.json({ bot });
      }
      if (/^\/bots\/[^/]+\/chats$/.test(path)) return Response.json(await request.json());
      if (path.startsWith("/chats/") && request.method === "DELETE") {
        state.deleted.push(path.split("/").at(-1)!);
        return Response.json({});
      }
      if (path === "/turns") {
        const turn = (await request.json()) as Turn;
        state.turns.push(turn);
        await state.onTurn(turn);
        const run = { id: crypto.randomUUID(), chatId: turn.chatId!, status: "done" };
        runs.set(run.id, run);
        return Response.json(run);
      }
      const runId = path.split("/")[2]!;
      if (path.endsWith("/stream"))
        return new Response(
          state.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      if (path.endsWith("/cancel")) {
        state.cancelled.push(runId);
        return Response.json({});
      }
      if (runs.has(runId)) return Response.json(runs.get(runId));
      return new Response(`Fixture route missing: ${path}`, { status: 404 });
    },
  });
  return { state, server };
}

let fixture: ReturnType<typeof runtimeFixture>;
let mcp: ReturnType<typeof Bun.serve>;
beforeEach(() => {
  alice.email = `assistant-${crypto.randomUUID()}@example.test`;
  db.delete(schema.mailAssistantConnection).run();
  db.delete(schema.mailAssistant).run();
  db.delete(schema.mailJob).run();
  db.delete(schema.mailGrant).run();
  fixture = runtimeFixture();
  const app = new Hono().route("/mcp", mailMcpRoutes);
  mcp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  env.MAIL_PUBLIC_URL = `http://127.0.0.1:${mcp.port}`;
  env.MAIL_MINDWIRE_TARGETS = JSON.stringify({
    [mailboxId(alice)]: {
      url: `http://127.0.0.1:${fixture.server.port}`,
      token: hostToken,
      agent: "codex",
      directory: "/isolated-mail",
    },
  });
});
afterEach(() => {
  fixture.server.stop(true);
  mcp.stop(true);
  env.MAIL_PUBLIC_URL = undefined;
  env.MAIL_MINDWIRE_TARGETS = "{}";
});

function mailServer(turn: Turn) {
  return (
    turn.options!.mcpServers as {
      mcpServers: { openship_mail: { url: string; httpHeaders: Record<string, string> } };
    }
  ).mcpServers.openship_mail;
}

describe("published Mindwire SDK mail integration", () => {
  it("uses authenticated tRPC streaming and rejects stale mailboxes and hostile origins before starting a turn", async () => {
    await configureAssistant(alice, true);
    const api = router({ assistant: assistantRouter });
    const app = new Hono().use(
      "/trpc/*",
      trpcServer({
        router: api,
        endpoint: "/trpc",
        createContext: (_, hono) =>
          buildContext(
            {
              ...alice,
              sessionId: "test-session",
              name: null,
              expiresAt: new Date(Date.now() + 60000),
            },
            hono,
          ),
      }),
    );
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const client = (origin: string) =>
      createTRPCClient<typeof api>({
        links: [
          httpBatchStreamLink({
            url: `http://127.0.0.1:${server.port}/trpc`,
            transformer: superjson,
            headers: { Origin: origin },
          }),
        ],
      });
    try {
      const local = client(`http://127.0.0.1:${server.port}`);
      await expect(
        local.assistant.stream.mutate({ mailboxId: mailboxId(bob), prompt: "Read mail" }),
      ).rejects.toThrow("mailbox has changed");
      await expect(
        local.assistant.cancel.mutate({
          mailboxId: mailboxId(bob),
          requestId: crypto.randomUUID(),
        }),
      ).rejects.toThrow("mailbox has changed");
      await expect(
        client("https://untrusted.test").assistant.stream.mutate({
          mailboxId: mailboxId(alice),
          prompt: "Read mail",
        }),
      ).rejects.toThrow("Origin not allowed");
      expect(fixture.state.turns).toHaveLength(0);
      const stream = await local.assistant.stream.mutate({
        mailboxId: mailboxId(alice),
        prompt: "Check my inbox",
      });
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events[0]).toMatchObject({ type: "started" });
      expect(events.at(-1)).toMatchObject({ type: "done", message: { text: "Hello there" } });
      expect(fixture.state.turns).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  it("streams text and safe mail tool status through the existing controller and encrypted history", async () => {
    await configureAssistant(alice, true);
    fixture.state.events.splice(
      1,
      0,
      {
        type: "tool_use",
        tool: {
          id: "read",
          name: "mcp__openship_mail__mail_read",
          input: { secret: "private-runtime-input" },
        },
      },
      {
        type: "tool_result",
        tool: {
          id: "read",
          name: "mcp__openship_mail__mail_read",
          output: "private-runtime-output",
        },
      },
      { type: "tool_use", tool: { id: "internal", name: "shell", input: "private-command" } },
    );
    const events = [];
    for await (const event of streamAssistant(alice, "Check my inbox")) events.push(event);
    expect(events[0]).toMatchObject({ type: "started" });
    expect(events.filter((event) => event.type === "text").at(-1)).toEqual({
      type: "text",
      text: "Hello there",
    });
    expect(events.filter((event) => event.type === "tool").at(-1)).toEqual({
      type: "tool",
      tool: { id: "read", name: "mail_read", state: "completed" },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", message: { text: "Hello there" } });
    expect(JSON.stringify(events)).not.toContain("private-");
    expect(assistantState(alice).messages).toHaveLength(2);
    expect(assistantState(bob).messages).toHaveLength(0);
    expect(JSON.stringify(db.select().from(schema.mailAssistant).all())).not.toContain(
      "Hello there",
    );
    const token = mailServer(fixture.state.turns[0]!).httpHeaders.Authorization!.slice(7);
    expect(authenticateGrant(token)).toBeNull();
  });

  it("allows only the owner to stop the matching active turn and does not save partial replies", async () => {
    await configureAssistant(alice, true);
    let release!: () => void;
    let entered!: () => void;
    const enteredTurn = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.state.onTurn = async () => {
      entered();
      await blocked;
    };
    const stream = streamAssistant(alice, "Check my inbox");
    const first = await stream.next();
    if (first.done || first.value.type !== "started") throw new Error("Expected an active turn");
    const requestId = first.value.requestId;
    await enteredTurn;
    expect(await cancelAssistant(bob, requestId)).toEqual({ cancelled: false });
    expect(await cancelAssistant(alice, crypto.randomUUID())).toEqual({ cancelled: false });
    expect(await cancelAssistant(alice, requestId)).toEqual({ cancelled: true });
    release();
    await expect(stream.next()).rejects.toThrow("could not complete");
    expect(fixture.state.cancelled).toHaveLength(1);
    expect(assistantState(alice).messages).toHaveLength(0);
    const token = mailServer(fixture.state.turns[0]!).httpHeaders.Authorization!.slice(7);
    expect(authenticateGrant(token)).toBeNull();
    expect(await cancelAssistant(alice, requestId)).toEqual({ cancelled: false });
  });

  it("revokes per-turn access and releases the mailbox when a stream reader disconnects", async () => {
    await configureAssistant(alice, true);
    let release!: () => void;
    let entered!: () => void;
    const enteredTurn = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.state.onTurn = async () => {
      entered();
      await blocked;
    };
    const stream = streamAssistant(alice, "Read my mail");
    await stream.next();
    await enteredTurn;
    const closed = stream.return();
    release();
    await closed;
    expect(fixture.state.cancelled).toHaveLength(1);
    expect(assistantState(alice).messages).toHaveLength(0);
    fixture.state.onTurn = async () => {};
    await expect(askAssistant(alice, "Try again")).resolves.toMatchObject({ text: "Hello there" });
  });

  it("prepares AI only on request and reports progress without granting mailbox access", async () => {
    fixture.state.configured = false;
    expect(await prepareAssistant(alice, "openai")).toMatchObject({ ready: false, running: false });
    expect(fixture.state.requests).toHaveLength(0);
    expect(await prepareAssistant(alice, "openai", true)).toMatchObject({
      ready: false,
      running: true,
    });
    expect(assistantState(alice).enabled).toBe(false);
    expect(db.select().from(schema.mailGrant).all()).toHaveLength(0);
    fixture.state.configured = true;
    fixture.state.setupRunning = false;
    expect(await prepareAssistant(alice, "openai")).toMatchObject({ ready: true, running: false });
    expect(await prepareAssistant(bob, "openai")).toMatchObject({ ready: false, running: false });
  });
  it("connects an AI key through native auth, scopes metadata to its mailbox and disconnects", async () => {
    fixture.state.authenticated = false;
    const key = "test-only-provider-key";
    await connectAssistant(alice, { provider: "openai", apiKey: key, model: "" });
    expect(fixture.state.savedKey).toBe(key);
    expect(assistantState(alice).enabled).toBe(true);
    expect(assistantState(alice).allowSend).toBe(false);
    expect(assistantState(alice).connection?.name).toBe("OpenAI");
    expect(assistantState(bob).connection).toBeNull();
    expect(JSON.stringify(db.select().from(schema.mailAssistantConnection).all())).not.toContain(
      key,
    );
    expect(JSON.stringify(assistantState(alice))).not.toContain(key);
    await disconnectAssistant(bob);
    expect(fixture.state.savedKey).toBe(key);
    await disconnectAssistant(alice);
    expect(fixture.state.savedKey).toBe("");
    expect(assistantState(alice).enabled).toBe(false);
    expect(assistantState(alice).connection).toBeNull();
  });

  it("uses the registered custom provider without requiring a native account and removes its key", async () => {
    fixture.state.authenticated = false;
    await connectAssistant(alice, {
      provider: "custom",
      apiKey: "custom-test-key",
      model: "model-1",
      baseUrl: "https://ai.example.test/v1",
      name: "Private AI",
    });
    expect(assistantState(alice).connection?.model).toBe("openship-mail/model-1");
    expect(assistantState(alice).enabled).toBe(true);
    await askAssistant(alice, "Hello");
    expect(fixture.state.turns[0]?.options?.settings?.model).toBe("openship-mail/model-1");
    await disconnectAssistant(alice);
    expect(Object.keys(fixture.state.providers)).toHaveLength(0);
  });

  it("does not expose provider errors or leave permission enabled after a failed connection", async () => {
    fixture.state.authError = true;
    await expect(
      connectAssistant(alice, {
        provider: "openai",
        apiKey: "sensitive-key-in-upstream-error",
        model: "",
      }),
    ).rejects.toThrow("Could not connect");
    expect(fixture.state.savedKey).toBe("");
    expect(assistantState(alice).enabled).toBe(false);
    expect(assistantState(alice).connection).toBeNull();
    expect(db.select().from(schema.mailGrant).all()).toHaveLength(0);
  });

  it("rejects credential-bearing and non-HTTPS custom URLs before touching a runtime", async () => {
    for (const baseUrl of [
      "http://example.test/v1",
      "https://user:pass@example.test/v1",
      "https://example.test/v1?key=secret",
    ]) {
      await expect(
        connectAssistant(alice, { provider: "custom", apiKey: "key", model: "m", baseUrl }),
      ).rejects.toThrow("HTTPS");
    }
    expect(fixture.state.requests).toHaveLength(0);
  });

  it("cancels provider setup without allowing a late connection to re-enable mail access", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.state.onAuthStep = async () => {
      entered();
      await waiting;
    };
    const connect = connectAssistant(alice, {
      provider: "openai",
      apiKey: "cancelled-key",
      model: "",
    });
    await started;
    await disconnectAssistant(alice);
    await expect(
      connectAssistant(alice, { provider: "openai", apiKey: "new-key", model: "" }),
    ).rejects.toThrow("in progress");
    release();
    await expect(connect).rejects.toThrow("cancelled");
    expect(fixture.state.savedKey).toBe("");
    expect(assistantState(alice).enabled).toBe(false);
    expect(assistantState(alice).busy).toBe(false);
    expect(assistantState(alice).connection).toBeNull();
  });

  it("keeps a failed key cleanup retryable while revoking mailbox access immediately", async () => {
    await connectAssistant(alice, { provider: "openai", apiKey: "saved-key", model: "" });
    fixture.state.logoutError = true;
    await expect(disconnectAssistant(alice)).rejects.toThrow("Mail access is off");
    expect(assistantState(alice).enabled).toBe(false);
    expect(assistantState(alice).connection?.name).toBe("OpenAI");
    fixture.state.logoutError = false;
    await disconnectAssistant(alice);
    expect(assistantState(alice).connection).toBeNull();
    expect(fixture.state.savedKey).toBe("");
  });

  it("does no runtime work on page reads and never inherits another mailbox host or history", async () => {
    expect(assistantState(alice).configured).toBe(true);
    expect(assistantState(bob).configured).toBe(false);
    expect(fixture.state.requests).toHaveLength(0);
    await expect(configureAssistant(bob, true)).rejects.toThrow("assigned to this mailbox");
    await configureAssistant(alice, true);
    const result = await askAssistant(alice, "Help with my inbox");
    expect(result.text).toBe("Hello there");
    expect(assistantState(alice).messages).toHaveLength(2);
    expect(assistantState(bob).messages).toHaveLength(0);
    expect(JSON.stringify(assistantState(alice))).not.toContain(hostToken);
    const token = mailServer(fixture.state.turns[0]!).httpHeaders.Authorization!.slice(7);
    expect(authenticateGrant(token)).toBeNull();
    expect(
      db
        .select()
        .from(schema.mailAssistant)
        .where(eq(schema.mailAssistant.mailboxId, mailboxId(alice)))
        .get()!
        .history.toString(),
    ).not.toContain("Hello");
  });

  it("gates unsupported runtimes and missing provider authentication before enabling", async () => {
    fixture.state.botsVersion = 8;
    await expect(configureAssistant(alice, true)).rejects.toThrow("Update the assigned");
    fixture.state.botsVersion = 9;
    fixture.state.configured = false;
    await expect(configureAssistant(alice, true)).rejects.toThrow("Connect your AI provider");
    expect(assistantState(alice).enabled).toBe(false);
    expect(fixture.state.turns).toHaveLength(0);
  });

  it("requires separate mailbox endpoints and HTTPS outside local development", () => {
    const bindings = JSON.parse(env.MAIL_MINDWIRE_TARGETS);
    bindings[mailboxId(bob)] = bindings[mailboxId(alice)];
    env.MAIL_MINDWIRE_TARGETS = JSON.stringify(bindings);
    expect(() => assistantTarget(mailboxId(alice))).toThrow("own isolated");
    delete bindings[mailboxId(bob)];
    bindings[mailboxId(alice)].url = "http://remote.example.test";
    env.MAIL_MINDWIRE_TARGETS = JSON.stringify(bindings);
    expect(() => assistantTarget(mailboxId(alice))).toThrow("HTTPS");
  });

  it("makes disabling win over an in-flight setup request", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.state.onHealth = () => {
      entered();
      return waiting;
    };
    const enable = configureAssistant(alice, true);
    await started;
    await configureAssistant(alice, false);
    fixture.state.onHealth = async () => {};
    release();
    const error = await enable.then(
      () => null,
      (error: Error) => error,
    );
    expect(error?.message).toContain("cancelled");
    expect(assistantState(alice).enabled).toBe(false);
    expect(db.select().from(schema.mailGrant).all()).toHaveLength(0);
  });

  it("creates approval-only mail through the real MCP endpoint and keeps owner consent after the turn", async () => {
    await configureAssistant(alice, true, true);
    fixture.state.onTurn = async (turn) => {
      const config = mailServer(turn);
      const token = config.httpHeaders.Authorization!.slice(7);
      expect(authenticateGrant(token)?.mailbox.email).toBe(alice.email);
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          ...config.httpHeaders,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "mail_prepare_send",
            arguments: {
              to: ["recipient@example.test"],
              subject: "Proposal",
              text: "Fixture only",
              approved: true,
            },
          },
        }),
      });
      const body = await response.json();
      expect(body.result.isError).toBeUndefined();
    };
    await askAssistant(alice, "Draft a reply for review");
    expect(listJobs(alice).items[0]?.state).toBe("approval");
    expect(listJobs(bob).items).toHaveLength(0);
    await configureAssistant(alice, false);
    expect(listJobs(alice).items[0]?.state).toBe("cancelled");
  });

  it("keeps compose suggestions tool-free and separate from the global conversation", async () => {
    await configureAssistant(alice, true, true);
    await askAssistant(alice, "Improve this draft", { compose: true });
    const turn = fixture.state.turns[0]!;
    expect(turn.options!.mcpServers).toEqual({ mcpServers: {} });
    expect(turn.options!.settings).toMatchObject({ permissionMode: "never", sandbox: "read-only" });
    expect(fixture.state.deleted).toContain(turn.chatId!);
    expect(assistantState(alice).messages).toHaveLength(0);
  });

  it("separates Claude built-in tool selection from MCP permissions for chat and compose", async () => {
    const bindings = JSON.parse(env.MAIL_MINDWIRE_TARGETS);
    bindings[mailboxId(alice)].agent = "claude-code";
    env.MAIL_MINDWIRE_TARGETS = JSON.stringify(bindings);
    await configureAssistant(alice, true);
    await askAssistant(alice, "Help with my inbox");
    const chat = fixture.state.turns[0]!;
    expect(chat.options!.settings).toMatchObject({
      permissionMode: "dontAsk",
      allowedTools: "AskUserQuestion",
      allowRules: "mcp__openship_mail__*",
    });
    expect(chat.options!.claudeSettings).toMatchObject({
      disableAllHooks: true,
      permissions: {
        allow: ["mcp__openship_mail__*"],
        deny: ["AskUserQuestion", "mcp__mindwire_desktop__*"],
      },
    });
    const servers = chat.options!.mcpServers as {
      mcpServers: { openship_mail: { type: string; headers: { Authorization: string } } };
    };
    expect(servers.mcpServers.openship_mail.type).toBe("http");
    expect(
      authenticateGrant(servers.mcpServers.openship_mail.headers.Authorization.slice(7)),
    ).toBeNull();
    await askAssistant(alice, "Improve this sentence", { compose: true });
    const compose = fixture.state.turns[1]!;
    expect(compose.options!.mcpServers).toEqual({ mcpServers: {} });
    expect(compose.options!.claudeSettings).toMatchObject({ permissions: { allow: [] } });
    expect(compose.options!.settings!.allowedTools).toBe("AskUserQuestion");
  });

  it("discards a response and revokes access when disabled during a turn", async () => {
    await configureAssistant(alice, true);
    fixture.state.onTurn = async () => {
      await configureAssistant(alice, false);
    };
    await expect(askAssistant(alice, "Read my mail")).rejects.toThrow("could not complete");
    expect(assistantState(alice).messages).toHaveLength(0);
    expect(fixture.state.cancelled).toHaveLength(1);
    const token = mailServer(fixture.state.turns[0]!).httpHeaders.Authorization!.slice(7);
    expect(authenticateGrant(token)).toBeNull();
  });
});
