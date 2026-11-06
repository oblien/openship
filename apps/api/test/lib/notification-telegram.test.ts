import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationChannel } from "@repo/db";
import { consoleErrorSink, errorReporter, reportError, type ErrorEvent } from "@repo/core/diagnostics";

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

vi.mock("@repo/platform/engine/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetch(...(args as [])),
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  get env() {
    return { CLOUD_MODE: false, NOTIFY_WEBHOOK_ALLOW_INTERNAL: false };
  },
}));
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("@repo/platform/engine/lib/mail", () => ({ sendMail: vi.fn() }));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: (v: string) => v }));

const { sendTestToChannel, buildTelegramText } = await import("@repo/platform/engine/lib/notification-workers");

const TOKEN = "123456789:AAHrandomlookingbottokenvalue0001";

const telegramChannel = (config: Record<string, unknown>) =>
  ({ id: "ch_1", kind: "telegram", config }) as unknown as NotificationChannel;

const lastCall = () => {
  const call = safeFetch.mock.calls.at(-1) as unknown as [string, { body: string }];
  return { url: call[0], body: JSON.parse(call[1].body) as Record<string, unknown>, opts: call[1] };
};

describe("telegram delivery", () => {
  it("keeps the channel's opaque token out of diagnostic events as well as the returned error", async () => {
    await errorReporter.flush();
    const events: ErrorEvent[] = [];
    errorReporter.setEnabled(true);
    errorReporter.setSink((batch) => { events.push(...batch); });
    safeFetch.mockRejectedValueOnce(new Error(`Transport failed for ${TOKEN}`));
    try {
      const failure = await sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "test" }))
        .catch((error) => { reportError(error, { component: "notification-api-boundary" }); return error; });
      expect(failure).toBeInstanceOf(Error);
      await errorReporter.flush();
      expect(events).toHaveLength(1);
      expect(events[0]!.error.message).toBe("Notification delivery failed");
      expect(JSON.stringify(events)).not.toContain(TOKEN);
    } finally {
      errorReporter.setEnabled(false);
      errorReporter.setSink(consoleErrorSink);
    }
  });

  it("keeps credentials out of diagnostics when reading a provider response fails", async () => {
    await errorReporter.flush();
    const events: ErrorEvent[] = [];
    errorReporter.setEnabled(true);
    errorReporter.setSink((batch) => { events.push(...batch); });
    safeFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => { throw Object.assign(new Error(`Read failed for ${TOKEN}`), { code: "ECONNRESET" }); },
    });
    try {
      await expect(sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "test" })))
        .resolves.toBeUndefined();
      await errorReporter.flush();
      expect(events).toHaveLength(1);
      expect(events[0]!.error.message).toBe("The Telegram response could not be read (ECONNRESET)");
      expect(JSON.stringify(events)).not.toContain(TOKEN);
    } finally {
      errorReporter.setEnabled(false);
      errorReporter.setSink(consoleErrorSink);
    }
  });

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

  it("treats HTTP 200 with { ok: false } as a failure and reports approved evidence", async () => {
    // The single most common misconfiguration: a bot the user never started.
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }),
    });

    await expect(
      sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "12345" })),
    ).rejects.toThrow(/Check the bot’s chat access and permissions.*HTTP 403/);
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

  it("does not read an unsuccessful provider body to construct an error", async () => {
    const text = vi.fn(async () => { throw new Error("unregistered-private-provider-value"); });
    safeFetch.mockResolvedValueOnce({ ok: false, status: 403, text });
    await expect(sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "test" })))
      .rejects.toThrow("Telegram delivery failed (HTTP 403)");
    expect(text).not.toHaveBeenCalled();
  });

  it("never leaks the bot token through a transport error", async () => {
    // The token is a URL path segment, so any error that echoes the URL would
    // persist it into the delivery row and show it in the dashboard.
    safeFetch.mockRejectedValue(
      Object.assign(new Error(`connect ETIMEDOUT https://api.telegram.org/bot${TOKEN}/sendMessage`), { code: "ETIMEDOUT" }),
    );

    await expect(
      sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "12345" })),
    ).rejects.toThrow("Notification delivery failed (ETIMEDOUT)");
    await expect(
      sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "12345" })),
    ).rejects.not.toThrow(TOKEN);
  });

  it("omits long provider text from public errors", async () => {
    const token = "private-value-".repeat(1600);
    safeFetch.mockRejectedValueOnce(new Error(`Transport failed for ${token}: connection refused`));
    await expect(sendTestToChannel(telegramChannel({ botToken: token, chatId: "test" })))
      .rejects.toThrow("Notification delivery failed");
  });

  it("keeps overlapping and JSON-escaped channel credentials out of public errors", async () => {
    const secret = 'private"value\nnext';
    safeFetch.mockRejectedValueOnce(new Error(`x ${JSON.stringify(secret)}`));
    await expect(sendTestToChannel(telegramChannel({
      botToken: "x", chatId: "test", hmacSecret: "redacted", webhookUrl: secret,
    }))).rejects.toThrow("Notification delivery failed");
  });

  it.each([false, true])("omits provider response text while preserving failure status (HTTP success: %s)", async (ok) => {
    const description = `${"p".repeat(195)}${TOKEN} connection refused`;
    safeFetch.mockResolvedValueOnce({
      ok, status: ok ? 200 : 400,
      text: async () => ok ? JSON.stringify({ ok: false, error_code: 403, description }) : description,
    });
    const error = await sendTestToChannel(telegramChannel({ botToken: TOKEN, chatId: "test" }))
      .catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`HTTP ${ok ? 403 : 400}`);
    expect((error as Error).message).not.toContain("p".repeat(195));
    expect((error as Error).message).not.toContain(TOKEN.slice(0, 5));
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
