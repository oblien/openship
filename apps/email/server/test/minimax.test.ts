import { describe, expect, it } from "bun:test";
import type { AppContext } from "../src/ctx";
import { createMiniMaxChatCompletion } from "../src/lib/minimax";
import { createAiRouter } from "../src/trpc/routes/ai";

const CASES = [
  { model: "MiniMax-M3.1-Flash", baseUrl: "https://api.minimax.io/v1" },
  { model: "MiniMax-M3.1-Flash", baseUrl: "https://api.minimaxi.com/v1" },
  { model: "custom-model", baseUrl: "https://api.minimax.io/v1" },
  { model: "custom-model", baseUrl: "https://api.minimaxi.com/v1" },
  { model: "MiniMax-M3", baseUrl: "https://api.minimax.io/v1" },
  { model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1" },
  { model: "MiniMax-M2.7", baseUrl: "https://api.minimax.io/v1" },
  { model: "MiniMax-M2.7", baseUrl: "https://api.minimaxi.com/v1" },
] as const;

const context: AppContext = {
  session: {
    sessionId: "session-id",
    email: "sender@example.com",
    name: "Sender",
    password: "mail-password",
    imapHost: "mail.example.com",
    imapPort: 993,
    smtpHost: "mail.example.com",
    smtpPort: 465,
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  },
  imap: {
    host: "mail.example.com",
    port: 993,
    user: "sender@example.com",
    pass: "mail-password",
  },
  smtp: {
    host: "mail.example.com",
    port: 465,
    user: "sender@example.com",
    pass: "mail-password",
  },
  hono: null,
};

describe("MiniMax chat completions", () => {
  for (const { model, baseUrl } of CASES) {
    it(`sends ${model} requests through ${baseUrl}`, async () => {
      type FetchArgs = Parameters<typeof fetch>;
      const calls: FetchArgs[] = [];
      const fetchImpl = (async (...args: FetchArgs) => {
        calls.push(args);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "Generated text" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      const content = await createMiniMaxChatCompletion(
        { apiKey: "test-key", model, baseUrl },
        [{ role: "user", content: "Draft an email" }],
        fetchImpl,
      );

      expect(content).toBe("Generated text");
      expect(calls).toHaveLength(1);

      const [url, init] = calls[0]!;
      expect(String(url)).toBe(`${baseUrl}/chat/completions`);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
      expect(JSON.parse(String(init?.body))).toEqual({
        model,
        messages: [{ role: "user", content: "Draft an email" }],
      });
    });
  }
});

describe("MiniMax environment-to-HTTP requests", () => {
  for (const baseUrl of ["https://api.minimax.io/v1", "https://api.minimaxi.com/v1"]) {
    for (const model of [
      undefined,
      "MiniMax-M3.1-Flash",
      "MiniMax-M3",
      "MiniMax-M2.7",
      "custom-model",
    ]) {
      it(`uses ${model ?? "the Flash default"} through ${baseUrl} without losing thread history`, () => {
        const thread = [
          {
            from: "colleague@example.com",
            to: ["sender@example.com"],
            subject: "Release",
            body: "Please preserve this previous message.",
          },
        ];
        // A separate process exercises startup env parsing and the default router
        // dependencies without sharing module caches or changing the test process env.
        const script = `
          const calls = [];
          globalThis.fetch = async (url, init) => {
            calls.push({ url, method: init.method, body: JSON.parse(init.body) });
            return Response.json({ choices: [{ message: { content: "Generated text" } }] });
          };
          const { aiRouter } = await import(${JSON.stringify(new URL("../src/trpc/routes/ai.ts", import.meta.url).href)});
          const caller = aiRouter.createCaller(${JSON.stringify(context)});
          const compose = await caller.compose({ prompt: "Reply", emailSubject: "Release", to: [], threadMessages: ${JSON.stringify(thread)} });
          const subject = await caller.generateEmailSubject({ message: "Release is ready" });
          console.log(JSON.stringify({ calls, compose, subject }));
        `;
        const child = Bun.spawnSync([process.execPath, "-e", script], {
          env: {
            NODE_ENV: "test",
            SESSION_ENCRYPTION_KEY: "test-session-key",
            BRANDING_ADMIN_TOKEN: "test-branding-token",
            MINIMAX_API_KEY: "test-key",
            MINIMAX_BASE_URL: baseUrl,
            ...(model ? { MINIMAX_MODEL: model } : {}),
          },
        });
        expect(child.exitCode, child.stderr.toString()).toBe(0);
        const result = JSON.parse(child.stdout.toString());
        expect(result.compose).toEqual({ newBody: "Generated text" });
        expect(result.subject).toEqual({ subject: "Generated text" });
        expect(result.calls).toHaveLength(2);
        for (const call of result.calls) {
          expect(call.url).toBe(`${baseUrl}/chat/completions`);
          expect(call.method).toBe("POST");
          expect(call.body.model).toBe(model ?? "MiniMax-M3.1-Flash");
          // Let the provider apply its supported thinking/effort defaults.
          expect(Object.keys(call.body).sort()).toEqual(["messages", "model"]);
        }
        expect(JSON.parse(result.calls[0].body.messages[1].content).thread).toEqual(thread);
        expect(result.calls[1].body.messages[1].content).toBe("Release is ready");
      });
    }
  }
});

describe("MiniMax AI routes", () => {
  it("replaces compose and subject stubs with generated content", async () => {
    const responses = ["Hello team,\n\nThe release is ready.", 'Subject: "Release ready"'];
    const complete = async () => responses.shift()!;
    const getConfig = () =>
      ({
        apiKey: "test-key",
        model: "MiniMax-M3",
        baseUrl: "https://api.minimax.io/v1",
      }) as const;
    const caller = createAiRouter(complete, getConfig).createCaller(context);

    await expect(
      caller.compose({
        prompt: "Tell the team the release is ready.",
        emailSubject: "",
        to: ["team@example.com"],
        cc: [],
        threadMessages: [],
      }),
    ).resolves.toEqual({ newBody: "Hello team,\n\nThe release is ready." });

    await expect(
      caller.generateEmailSubject({ message: "Hello team, the release is ready." }),
    ).resolves.toEqual({ subject: "Release ready" });
  });
});
