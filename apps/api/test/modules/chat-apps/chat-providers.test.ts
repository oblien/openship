import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK } from "jose";
import type { ChatAppConnection } from "@repo/db";
import {
  createChatProviders,
  normalizeMessage,
  commandText,
} from "../../../src/modules/chat-apps/transport/providers";
import type { BotConfiguration } from "../../../src/modules/chat-apps/transport/types";
import { APP_LOCALES } from "@repo/core";
import { chatDictionaries } from "../../../src/modules/chat-apps/chat-copy";

const connection = (provider: string, purpose: ChatAppConnection["purpose"] = "commands") =>
  ({
    id: "connector",
    provider,
    purpose,
    assistantAllowed: purpose !== "commands",
    transport: "webhook",
    enabled: true,
    revision: 1,
  }) as ChatAppConnection;
const config = (over: Partial<BotConfiguration> = {}): BotConfiguration => ({
  botId: "300",
  username: "mybot",
  channelIds: ["100"],
  workspaceId: "200",
  applicationId: "300",
  credentials: {
    botToken: "123:fixture",
    signingSecret: "slack_fixture_secret",
    webhookSecret: "telegram_fixture_secret",
  },
  ...over,
});

describe("chat presentation", () => {
  it("has complete translations with identical template fields in every OpenShip language", () => {
    function check(base: any, translated: any) {
      expect(Object.keys(translated).sort()).toEqual(Object.keys(base).sort());
      for (const key of Object.keys(base)) {
        if (typeof base[key] === "object") check(base[key], translated[key]);
        else {
          expect(translated[key].length).toBeGreaterThan(0);
          expect((translated[key].match(/\{\w+\}/g) ?? []).sort()).toEqual(
            (base[key].match(/\{\w+\}/g) ?? []).sort(),
          );
        }
      }
    }
    for (const locale of APP_LOCALES) check(chatDictionaries.en, chatDictionaries[locale]);
  });
  it("keeps Discord follow-up messages private and separate from the original response", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const providers = createChatProviders(fetch);
    const event = {
      id: "1",
      workspaceId: "200",
      userId: "42",
      channelId: "100",
      command: true,
      text: "link",
      reply: { token: "private_token" },
    };
    await providers.send(
      connection("discord"),
      config(),
      event,
      { text: "Open the next link." },
      0,
    );
    await providers.send(
      connection("discord"),
      config(),
      event,
      { text: "https://openship.example/settings?link=code" },
      1,
    );
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["PATCH", "POST"]);
    expect(fetch.mock.calls[1]?.[0]).toBe("https://discord.com/api/v10/webhooks/300/private_token");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      flags: 64,
      allowed_mentions: { parse: [] },
    });
  });
  it("accepts Telegram buttons only on this bot's messages, in allowed chats", () => {
    const update = {
      update_id: 99,
      callback_query: {
        id: "99",
        data: `os:${"x".repeat(32)}`,
        from: { id: 42 },
        message: { chat: { id: 100 }, from: { id: 300, is_bot: true }, message_thread_id: 12 },
      },
    };
    expect(normalizeMessage(connection("telegram"), config(), update)).toMatchObject({
      userId: "42",
      threadId: "12",
      callback: "x".repeat(32),
      reply: { callbackId: "99" },
    });
    update.callback_query.message.from.id = 301;
    expect(normalizeMessage(connection("telegram"), config(), update)).toBeNull();
    update.callback_query.message.from.id = 300;
    update.callback_query.message.chat.id = 999;
    expect(normalizeMessage(connection("telegram"), config(), update)).toBeNull();
  });
});
const slack = (text = "/openship-projects") =>
  new URLSearchParams({
    command: text,
    text: "",
    team_id: "200",
    user_id: "sender",
    channel_id: "100",
    trigger_id: "delivery",
  }).toString();
const signedSlack = (body: string, timestamp = String(Math.floor(Date.now() / 1000))) => ({
  "content-type": "application/x-www-form-urlencoded",
  "x-slack-request-timestamp": timestamp,
  "x-slack-signature": `v0=${createHmac("sha256", "slack_fixture_secret").update(`v0:${timestamp}:${body}`).digest("hex")}`,
});

describe("Native provider authentication and normalization", () => {
  it("accepts Slack signatures over exact raw bytes and refuses stale, changed or wrong-workspace messages", async () => {
    const fetch = vi.fn(),
      providers = createChatProviders(fetch),
      receive = vi.fn();
    const raw = slack();
    await providers.forward(connection("slack"), config(), raw, signedSlack(raw), receive);
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "projects",
        userId: "sender",
        command: true,
        reply: { ephemeral: true },
      }),
    );
    await expect(
      providers.forward(connection("slack"), config(), raw + " ", signedSlack(raw), receive),
    ).rejects.toThrow("authenticate");
    await expect(
      providers.forward(connection("slack"), config(), raw, signedSlack(raw, "1"), receive),
    ).rejects.toThrow("authenticate");
    const wrong = raw.replace("team_id=200", "team_id=other");
    await providers.forward(connection("slack"), config(), wrong, signedSlack(wrong), receive);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not treat unrelated slash commands or other bots' Telegram commands as assistant prompts", () => {
    const c = connection("telegram", "both");
    expect(commandText(c, config(), "/help@mybot")).toEqual({ text: "help", command: true });
    expect(commandText(c, config(), "/help@anotherbot")).toBeNull();
    expect(commandText(c, config(), "/unknown")).toBeNull();
    expect(commandText(connection("telegram"), config(), "hello")).toBeNull();
    expect(commandText(c, config(), "hello")).toEqual({ text: "hello", command: false });
    expect(commandText(connection("slack"), config(), "/projects")).toBeNull();
    expect(commandText(connection("slack"), config(), "/openship-projects")).toEqual({
      text: "projects",
      command: true,
    });
    const raw = {
      update_id: 1,
      message: { text: "/help", chat: { id: 100 }, from: { id: 123, is_bot: true } },
    };
    expect(normalizeMessage(c, config(), raw)).toBeNull();
    raw.message.from.is_bot = false;
    expect(normalizeMessage(c, config(), raw)?.userId).toBe("123");
  });

  it("verifies Discord Ed25519 signatures, application and guild before queueing a private response", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicHex = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");
    const settings = config({ credentials: { publicKey: publicHex, botToken: "private" } });
    const providers = createChatProviders(vi.fn()),
      receive = vi.fn();
    const payload = {
      type: 2,
      id: "123",
      application_id: "300",
      guild_id: "200",
      channel_id: "100",
      member: { user: { id: "42" } },
      token: "private_reply_token",
      data: { name: "openship", options: [{ name: "projects", type: 1 }] },
    };
    async function forward(body: unknown, corrupt = false) {
      const raw = JSON.stringify(body),
        time = String(Math.floor(Date.now() / 1000));
      const signature = sign(null, Buffer.from(time + raw), privateKey).toString("hex");
      return providers.forward(
        connection("discord"),
        settings,
        raw + (corrupt ? " " : ""),
        { "x-signature-timestamp": time, "x-signature-ed25519": signature },
        receive,
      );
    }
    expect(JSON.parse((await forward(payload)).body)).toEqual({ type: 5, data: { flags: 64 } });
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "42", text: "projects" }),
    );
    await expect(forward(payload, true)).rejects.toThrow("authenticate");
    await expect(forward({ ...payload, application_id: "other" })).rejects.toThrow("authenticate");
    await forward({ ...payload, guild_id: "other" });
    await forward({
      ...payload,
      data: {
        name: "openship",
        options: [
          { name: "ask", type: 1, options: [{ name: "message", type: 3, value: "ignore roles" }] },
        ],
      },
    });
    expect(receive).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await forward({ type: 1, application_id: "300" })).body)).toEqual({
      type: 1,
    });
  });

  it("requires an endorsed Microsoft signature, tenant and pinned service URL for Teams", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...(await exportJWK(publicKey)), kid: "fixture", endorsements: ["msteams"] };
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe("https://login.botframework.com/v1/.well-known/keys");
      return Response.json({ keys: [jwk] });
    });
    const providers = createChatProviders(fetch),
      receive = vi.fn();
    const serviceUrl = "https://smba.trafficmanager.net/emea/";
    const settings = config({ serviceUrl });
    const payload = {
      type: "message",
      id: "activity",
      channelId: "msteams",
      serviceUrl,
      text: "/openship projects",
      from: { id: "user" },
      conversation: { id: "100" },
      channelData: { tenant: { id: "200" } },
    };
    const token = await new SignJWT({ serviceurl: serviceUrl })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer("https://api.botframework.com")
      .setAudience("300")
      .setNotBefore("-1m")
      .setExpirationTime("5m")
      .sign(privateKey);
    await providers.forward(
      connection("teams"),
      settings,
      JSON.stringify(payload),
      { authorization: `Bearer ${token}` },
      receive,
    );
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ text: "projects", workspaceId: "200" }),
    );
    await expect(
      providers.forward(
        connection("teams"),
        settings,
        JSON.stringify({ ...payload, serviceUrl: "https://attacker.example/" }),
        { authorization: `Bearer ${token}` },
        receive,
      ),
    ).rejects.toThrow("authenticate");
    await expect(
      providers.forward(
        connection("teams"),
        { ...settings, applicationId: "other" },
        JSON.stringify(payload),
        { authorization: `Bearer ${token}` },
        receive,
      ),
    ).rejects.toThrow("authenticate");
    await providers.forward(
      connection("teams"),
      settings,
      JSON.stringify({ ...payload, channelData: { tenant: { id: "other" } } }),
      { authorization: `Bearer ${token}` },
      receive,
    );
    expect(receive).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends only to fixed provider endpoints, suppresses Discord mentions and redacts failed requests", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const providers = createChatProviders(fetch),
      settings = config();
    await providers.send(
      connection("discord"),
      settings,
      {
        id: "event",
        userId: "42",
        workspaceId: "200",
        channelId: "100",
        text: "",
        command: true,
        reply: { token: "private_token" },
      },
      { text: "@everyone status" },
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://discord.com/api/v10/webhooks/300/private_token/messages/@original",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).allowed_mentions).toEqual({
      parse: [],
    });
    fetch.mockImplementation(async () => {
      throw new Error("credential leaked in request: private_token");
    });
    await expect(
      providers.send(
        connection("telegram"),
        settings,
        { id: "e", userId: "42", workspaceId: "", channelId: "100", command: true, text: "" },
        { text: "reply" },
      ),
    ).rejects.toThrow("chat provider");
    await expect(
      providers.send(
        connection("telegram"),
        settings,
        { id: "e", userId: "42", workspaceId: "", channelId: "100", command: true, text: "" },
        { text: "reply" },
      ),
    ).rejects.not.toThrow("private_token");
  });

  it("recognizes an already-deferred Discord interaction without hiding other failures", async () => {
    const fetch = vi.fn(async () => Response.json({ code: 40060 }, { status: 400 }));
    const providers = createChatProviders(fetch),
      event = {
        id: "123",
        userId: "42",
        workspaceId: "200",
        channelId: "100",
        command: true,
        text: "help",
        reply: { token: "private_token" },
      };
    await expect(providers.acknowledgeDiscord(config(), event)).resolves.toBeUndefined();
    fetch.mockImplementation(async () => Response.json({ code: 10062 }, { status: 404 }));
    await expect(providers.acknowledgeDiscord(config(), event)).rejects.toThrow("chat provider");
  });
});
