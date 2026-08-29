import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationChannel } from "@repo/db";

/**
 * Telegram is the one channel where a well-formed request can come back HTTP 200
 * and still not have delivered, and where a single unescaped character in the
 * body drops the whole message. Both failure modes are silent by default — a
 * status-code check reports success and the channel flips to `verified` — so they
 * are asserted here rather than left to the live test button.
 *
 * The bot token lives in the URL path, which is also why the transport-error path
 * is covered: delivery errors are persisted to notification_delivery.error and
 * rendered in the dashboard.
 */
const safeFetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }),
}));

vi.mock("../../src/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetch(...(args as [])),
}));
vi.mock("../../src/config/env", () => ({
  get env() {
    return { CLOUD_MODE: false, NOTIFY_WEBHOOK_ALLOW_INTERNAL: false };
  },
}));
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("../../src/lib/mail", () => ({ sendMail: vi.fn() }));
vi.mock("../../src/lib/encryption", () => ({ decrypt: (v: string) => v }));

const { sendTestToChannel, buildTelegramText } = await import("../../src/lib/notification-workers");

const TOKEN = "123456789:AAHrandomlookingbottokenvalue0001";

const telegramChannel = (config: Record<string, unknown>) =>
  ({ id: "ch_1", kind: "telegram", config }) as unknown as NotificationChannel;

const lastCall = () => {
  const call = safeFetch.mock.calls.at(-1) as unknown as [string, { body: string }];
  return { url: call[0], body: JSON.parse(call[1].body) as Record<string, unknown>, opts: call[1] };
};

describe("telegram delivery", () => {
  beforeEach(() => {
    safeFetch.mockClear();
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }),
    });
  });

  it("posts sendMessage for the configured bot and chat", async () => {
    await sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "-1001234567890" }));

    const { url, body, opts } = lastCall();
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect((opts as { method: string }).method).toBe("POST");
    expect(body.chat_id).toBe("-1001234567890");
    expect(body.parse_mode).toBe("HTML");
    expect(body.disable_web_page_preview).toBe(true);
    // Went through the HTML builder, not the raw plain-text render.
    expect(String(body.text).startsWith("<b>")).toBe(true);
    expect(body.message_thread_id).toBeUndefined();
  });

  it("targets a forum topic as a number when one is configured", async () => {
    await sendTestToChannel(
      telegramChannel({ botToken: TOKEN, chatId: "-1001234567890", messageThreadId: "42" }),
    );
    expect(lastCall().body.message_thread_id).toBe(42);
  });

  it("treats HTTP 200 with { ok: false } as a failure and surfaces the description", async () => {
    // The single most common misconfiguration: a bot the user never started.
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }),
    });

    await expect(
      sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "12345" })),
    ).rejects.toThrow(/bot was blocked by the user/);
  });

  it("fails on a non-2xx status", async () => {
    safeFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"ok":false,"description":"Bad Request: chat not found"}',
    });

    await expect(
      sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "12345" })),
    ).rejects.toThrow(/400/);
  });

  it("never leaks the bot token through a transport error", async () => {
    // The token is a URL path segment, so any error that echoes the URL would
    // persist it into the delivery row and show it in the dashboard.
    safeFetch.mockRejectedValue(
      new Error(`connect ETIMEDOUT https://api.telegram.org/bot${TOKEN}/sendMessage`),
    );

    await expect(
      sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "12345" })),
    ).rejects.toThrow(/bot<redacted>/);
    await expect(
      sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "12345" })),
    ).rejects.not.toThrow(TOKEN);
  });

  it("refuses to send when half the config is missing", async () => {
    await expect(sendTestToChannel(telegramChannel({ chatId: "12345" }))).rejects.toThrow(
      /bot token/,
    );
    await expect(sendTestToChannel(telegramChannel({ botToken: TOKEN }))).rejects.toThrow(
      /chat ID/,
    );
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe("telegram HTML text builder", () => {
  it("escapes the three characters that would 400 the whole send", () => {
    const text = buildTelegramText({
      title: "Service down: a & b",
      body: 'panic: <nil> pointer\nexit > 0 & unrecoverable',
    });

    expect(text).toContain("a &amp; b");
    expect(text).toContain("&lt;nil&gt;");
    expect(text).toContain("&gt; 0 &amp; unrecoverable");
    // The bold wrapper is the only real markup left in the string.
    expect(text.replace(/^<b>|<\/b>/g, "")).not.toMatch(/[<>]/);
  });

  it("clamps to Telegram's 4096-char limit without leaving a half-written entity", () => {
    const text = buildTelegramText({ title: "Down", body: "&".repeat(5000) });

    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.endsWith("…")).toBe(true);
    // "…&am" would be rejected outright by the HTML parser.
    expect(text).not.toMatch(/&[a-z]*…$/);
  });

  it("leaves a short message untouched", () => {
    expect(buildTelegramText({ title: "Service recovered", body: "web · down for 3m 20s" })).toBe(
      "<b>Service recovered</b>\n\nweb · down for 3m 20s",
    );
  });
});
