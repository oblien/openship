import { describe, expect, it } from "bun:test";
import type { AppContext } from "../src/ctx";
import { createMiniMaxChatCompletion } from "../src/lib/minimax";
import { createAiRouter } from "../src/trpc/routes/ai";

const CASES = [
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
