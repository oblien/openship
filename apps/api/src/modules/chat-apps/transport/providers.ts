import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { chatNativeCommands } from "@repo/commands";
import { chatCopy, localizedChatMenu } from "../chat-copy";
import type { ChatMessage } from "../chat-reply";
import { AppError, type AppLocale } from "@repo/core";
import type { ChatAppConnection } from "@repo/db";
import { fail } from "../chat-apps-common";
import type {
  BotConfiguration,
  ChatSettings,
  IncomingMessage,
  ProviderFetch,
  Receive,
  WebhookResponse,
} from "./types";

const jsonResponse = (body: unknown, status = 200): WebhookResponse => ({
  status,
  body: JSON.stringify(body),
  contentType: "application/json",
});
const str = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const forbidden = () => fail("The provider could not authenticate this message.", 403);
const same = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const recent = (value: string) =>
  /^\d+$/.test(value) && Math.abs(Date.now() / 1000 - Number(value)) <= 300;
const encode = encodeURIComponent;
class ProviderRequestError extends AppError {
  constructor(readonly providerCode?: number) {
    super(
      "The chat provider could not complete this request. Check the bot credentials and permissions, then retry.",
      502,
      "CHAT_PROVIDER_ERROR",
    );
  }
}
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  getLevel() {
    return "error" as const;
  },
  setName() {},
};
export { silentLogger };

/** Converts advertised native commands to the one shared OpenShip command parser. */
export function commandText(
  c: ChatAppConnection,
  config: BotConfiguration,
  text: string,
): { text: string; command: boolean } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/"))
    return c.assistantAllowed ? { text: trimmed, command: false } : null;
  const [head = "", ...tail] = trimmed.split(/\s+/);
  const [name, target] = head.split("@");
  if (
    target &&
    (c.provider !== "telegram" || target.toLowerCase() !== config.username?.toLowerCase())
  )
    return null;
  if (name === "/openship") return { text: tail.join(" ") || "start", command: true };
  if (c.provider === "telegram" && name === "/start") return { text: "start", command: true };
  const alias = c.provider === "slack" ? name!.replace(/^\/openship-/, "") : name!.slice(1);
  if (chatNativeCommands(c.purpose).some((command) => command.name === alias))
    return { text: [alias, ...tail].join(" "), command: true };
  return null;
}

export function normalizeMessage(
  c: ChatAppConnection,
  config: BotConfiguration,
  body: any,
): IncomingMessage | null {
  let message: IncomingMessage | null = null;
  if (c.provider === "telegram") {
    const callback = body?.callback_query;
    const m = callback?.message ?? body?.message;
    const sender = callback?.from ?? m?.from;
    if (
      !m ||
      sender?.is_bot ||
      (callback &&
        (String(m.from?.id) !== config.botId ||
          !/^os:[A-Za-z0-9_-]{32}$/.test(callback.data ?? "") ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(callback.id ?? ""))) ||
      !Number.isSafeInteger(body.update_id) ||
      !Number.isSafeInteger(m.chat?.id) ||
      !Number.isSafeInteger(sender?.id)
    )
      return null;
    const input = callback ? { text: "help", command: true } : commandText(c, config, str(m.text));
    if (input)
      message = {
        ...input,
        id: String(body.update_id),
        workspaceId: "",
        userId: String(sender.id),
        ...(callback
          ? { callback: callback.data.slice(3), reply: { callbackId: callback.id } }
          : {}),
        channelId: String(m.chat.id),
        threadId: str(m.message_thread_id) || undefined,
      };
  } else if (c.provider === "slack") {
    const slash = typeof body?.command === "string";
    const m = slash ? body : body?.event;
    if (
      !m ||
      m.bot_id ||
      m.subtype ||
      (!slash && m.type !== "app_mention" && !(m.type === "message" && m.channel_type === "im"))
    )
      return null;
    const input = commandText(
      c,
      config,
      slash ? `${body.command} ${str(body.text)}` : str(m.text).replace(/^<@[A-Z0-9]+>\s*/, ""),
    );
    if (input)
      message = {
        ...input,
        id: str(slash ? body.trigger_id : body.event_id),
        workspaceId: str(body.team_id),
        userId: str(slash ? body.user_id : m.user),
        channelId: str(slash ? body.channel_id : m.channel),
        threadId: slash ? undefined : str(m.thread_ts || m.ts),
        reply: { ephemeral: slash },
      };
  } else if (c.provider === "discord") {
    if (
      body?.type !== 2 ||
      body.application_id !== config.applicationId ||
      body.data?.name !== "openship" ||
      body.member?.user?.bot
    )
      return null;
    const options = body.data.options ?? [];
    let text = "help";
    if (options.length) {
      if (options.length !== 1) return null;
      const opt = options[0];
      const command = chatNativeCommands(c.purpose).find((x) => x.name === opt.name);
      if (!command || opt.type !== 1) return null;
      const args = opt.options ?? [];
      if (
        command.argument
          ? args.length !== 1 ||
            args[0].name !== command.argument ||
            args[0].type !== 3 ||
            typeof args[0].value !== "string"
          : args.length !== 0
      )
        return null;
      text = `${command.name} ${args[0]?.value ?? ""}`.trim();
    }
    if (typeof body.token !== "string" || !/^[A-Za-z0-9._-]{1,2048}$/.test(body.token)) return null;
    message = {
      id: str(body.id),
      workspaceId: str(body.guild_id),
      userId: str(body.member?.user?.id),
      channelId: str(body.channel_id),
      command: true,
      text,
      reply: { token: body.token },
    };
  } else if (c.provider === "teams") {
    if (body?.type !== "message" || body.channelId !== "msteams" || body.from?.role === "bot")
      return null;
    const text = str(body.text)
      .replace(/<at>[^<]*<\/at>/g, "")
      .trim();
    const input = commandText(c, config, text.startsWith("openship ") ? `/${text}` : text);
    if (input)
      message = {
        ...input,
        id: str(body.id),
        workspaceId: str(body.channelData?.tenant?.id),
        userId: str(body.from?.id),
        channelId: str(body.conversation?.id),
        reply: { activityId: str(body.id) },
      };
  }
  if (
    !message ||
    !message.id ||
    !message.userId ||
    !message.channelId ||
    !message.text ||
    message.text.length > 16000 ||
    message.userId.length > 256 ||
    message.id.length > 512 ||
    (message.threadId && message.threadId.length > 256)
  )
    return null;
  if (
    !config.channelIds.includes(message.channelId) ||
    (c.provider !== "telegram" && message.workspaceId !== config.workspaceId)
  )
    return null;
  return message;
}

function teamsUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail("Enter the Microsoft Teams service URL.", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !["smba.trafficmanager.net", "smba.infra.teams.microsoft.com"].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  )
    throw fail("Use a Microsoft Teams connector HTTPS service URL.", 400);
  return url.href.replace(/\/$/, "");
}

export function createChatProviders(fetcher: ProviderFetch = fetch) {
  // Never surface SDK/provider error objects: they can include credential-bearing request URLs.
  async function request(url: string, init: RequestInit = {}): Promise<any> {
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(15000),
      });
      if (response.status === 204) return {};
      const raw = await response.text();
      if (raw.length > 2_000_000) throw new Error("Provider response too large");
      const value = raw ? JSON.parse(raw) : {};
      if (!response.ok || value.ok === false || value.error)
        throw new ProviderRequestError(typeof value.code === "number" ? value.code : undefined);
      return value;
    } catch (error) {
      throw error instanceof ProviderRequestError ? error : new ProviderRequestError();
    }
  }
  function json(url: string, body: unknown, token?: string, method = "POST", signal?: AbortSignal) {
    return request(url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
      body: JSON.stringify(body),
      signal,
    });
  }
  const telegram = (
    config: BotConfiguration,
    method: string,
    body: unknown = {},
    signal?: AbortSignal,
  ) =>
    json(
      `https://api.telegram.org/bot${config.credentials.botToken}/${method}`,
      body,
      undefined,
      "POST",
      signal,
    );
  const discord = (config: BotConfiguration, path: string, body?: unknown, method = "POST") =>
    body === undefined
      ? request(`https://discord.com/api/v10${path}`, {
          headers: { Authorization: `Bot ${config.credentials.botToken}` },
        })
      : json(
          `https://discord.com/api/v10${path}`,
          body,
          `Bot ${config.credentials.botToken}`,
          method,
        );
  let teamsKeys: { keys: JSONWebKeySet; until: number } | undefined;
  let keysRefreshAt = 0;
  async function verifyTeams(config: BotConfiguration, token: string, body: any) {
    if (!token.startsWith("Bearer ")) throw forbidden();
    if (!teamsKeys || teamsKeys.until < Date.now()) {
      if (keysRefreshAt > Date.now()) throw forbidden();
      keysRefreshAt = Date.now() + 60_000;
      const keys = await request("https://login.botframework.com/v1/.well-known/keys");
      if (!Array.isArray(keys.keys)) throw forbidden();
      teamsKeys = { keys, until: Date.now() + 3600_000 };
    }
    const endorsed = {
      keys: teamsKeys.keys.keys.filter((k) => {
        const endorsements = (k as { endorsements?: unknown }).endorsements;
        return Array.isArray(endorsements) && endorsements.includes("msteams");
      }),
    };
    try {
      const { payload } = await jwtVerify(token.slice(7), createLocalJWKSet(endorsed), {
        issuer: "https://api.botframework.com",
        audience: config.applicationId,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "nbf", "serviceurl"],
        clockTolerance: 300,
      });
      if (
        body.channelId !== "msteams" ||
        payload.serviceurl !== body.serviceUrl ||
        teamsUrl(body.serviceUrl) !== teamsUrl(config.serviceUrl!)
      )
        throw forbidden();
    } catch {
      throw forbidden();
    }
  }
  async function configure(
    c: ChatAppConnection,
    settings: ChatSettings,
  ): Promise<BotConfiguration> {
    const config: BotConfiguration = {
      ...settings,
      credentials: { ...settings.credentials },
      botId: "",
    };
    if (
      !config.channelIds.length ||
      config.channelIds.length > 20 ||
      config.channelIds.some((id) => !id || id.length > 256)
    )
      throw fail("Choose at least one allowed chat.", 400);
    for (const [key, value] of Object.entries(config.credentials))
      if (typeof value !== "string" || !value || value.length > 2048 || /[\s\x00-\x1f]/.test(value))
        throw fail(`Check the bot ${key}.`, 400);
    if (c.provider === "telegram") {
      if (
        !/^\d+:[A-Za-z0-9_-]+$/.test(config.credentials.botToken ?? "") ||
        config.channelIds.some((id) => !/^-?\d+$/.test(id))
      )
        throw fail("Check the Telegram bot token and numeric chat IDs.", 400);
      if (
        c.transport === "webhook" &&
        !/^[A-Za-z0-9_-]{16,256}$/.test(config.credentials.webhookSecret ?? "")
      )
        throw fail("Enter a Telegram webhook secret of at least 16 characters.", 400);
      const { result } = await telegram(config, "getMe");
      if (!result?.is_bot || !result.id || !result.username)
        throw fail("Telegram did not return a bot identity.", 400);
      config.botId = str(result.id);
      config.username = result.username;
    } else if (c.provider === "slack") {
      if (
        !/^T[A-Z0-9]+$/.test(config.workspaceId ?? "") ||
        !config.credentials.botToken?.startsWith("xoxb-") ||
        (c.transport === "outbound"
          ? !config.credentials.appToken?.startsWith("xapp-")
          : !config.credentials.signingSecret)
      )
        throw fail("Check the Slack workspace and bot credentials.", 400);
      const identity = await json(
        "https://slack.com/api/auth.test",
        {},
        `Bearer ${config.credentials.botToken}`,
      );
      if (identity.team_id !== config.workspaceId || !identity.bot_id)
        throw fail("This Slack bot belongs to a different workspace.", 400);
      config.botId = identity.bot_id;
    } else if (c.provider === "discord") {
      if (
        ![config.workspaceId, config.applicationId, ...config.channelIds].every((id) =>
          /^\d{1,20}$/.test(id ?? ""),
        ) ||
        !config.credentials.botToken ||
        (c.transport === "webhook" && !/^[a-fA-F0-9]{64}$/.test(config.credentials.publicKey ?? ""))
      )
        throw fail("Check the Discord server, application, channels and credentials.", 400);
      const identity = await discord(config, "/oauth2/applications/@me");
      if (identity.id !== config.applicationId)
        throw fail("This Discord bot belongs to a different application.", 400);
      if (c.transport === "outbound" && identity.interactions_endpoint_url)
        throw fail(
          "This Discord app already has an interactions endpoint. Remove it in Discord or use a separate bot for a direct connection.",
          400,
        );
      config.botId = identity.id;
    } else if (c.provider === "teams") {
      if (
        ![config.workspaceId, config.applicationId].every((id) =>
          /^[a-fA-F0-9-]{36}$/.test(id ?? ""),
        ) ||
        !config.credentials.clientSecret
      )
        throw fail("Check the Teams tenant, application and client secret.", 400);
      config.serviceUrl = teamsUrl(config.serviceUrl ?? "");
      config.botId = config.applicationId!;
    } else throw fail("Unsupported chat provider.", 400);
    return config;
  }
  async function activate(
    c: ChatAppConnection,
    config: BotConfiguration,
    locale: AppLocale = "en",
  ) {
    const commands = localizedChatMenu(c.purpose, locale);
    if (c.provider === "telegram") {
      if (c.transport === "outbound") {
        const { result } = await telegram(config, "getWebhookInfo");
        if (result?.url)
          throw fail(
            "This Telegram bot already has a webhook. Remove it in Telegram or use a separate bot for a direct connection.",
            400,
          );
      }
      await telegram(config, "setMyCommands", {
        commands: [
          { command: "openship", description: chatCopy(locale).menu },
          ...commands.map((x) => ({ command: x.name, description: x.description.slice(0, 256) })),
        ],
      });
    } else if (c.provider === "discord") {
      await discord(
        config,
        `/applications/${encode(config.applicationId!)}/guilds/${encode(config.workspaceId!)}/commands`,
        {
          name: "openship",
          description: "Work with your apps",
          type: 1,
          options: commands.map((x) => ({
            name: x.name,
            description: x.description.slice(0, 100),
            type: 1,
            ...(x.argument
              ? {
                  options: [
                    {
                      name: x.argument,
                      description: `Enter the ${x.argument.replaceAll("_", " ")}`,
                      type: 3,
                      required: true,
                    },
                  ],
                }
              : {}),
          })),
        },
      );
    }
  }
  async function forward(
    c: ChatAppConnection,
    config: BotConfiguration,
    raw: string,
    headers: Record<string, string>,
    receive: Receive,
  ) {
    let body: any;
    if (c.provider === "slack") {
      const timestamp = headers["x-slack-request-timestamp"] ?? "";
      const signature = `v0=${createHmac("sha256", config.credentials.signingSecret!).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
      if (!recent(timestamp) || !same(signature, headers["x-slack-signature"] ?? ""))
        throw forbidden();
      body = headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
        ? Object.fromEntries(new URLSearchParams(raw))
        : JSON.parse(raw);
      if (body.type === "url_verification") return jsonResponse({ challenge: body.challenge });
    } else if (c.provider === "telegram") {
      if (
        !same(config.credentials.webhookSecret!, headers["x-telegram-bot-api-secret-token"] ?? "")
      )
        throw forbidden();
      body = JSON.parse(raw);
    } else if (c.provider === "discord") {
      const timestamp = headers["x-signature-timestamp"] ?? "";
      const signature = headers["x-signature-ed25519"] ?? "";
      const key = createPublicKey({
        key: Buffer.from(`302a300506032b6570032100${config.credentials.publicKey}`, "hex"),
        format: "der",
        type: "spki",
      });
      if (
        !recent(timestamp) ||
        !/^[a-fA-F0-9]{128}$/.test(signature) ||
        !verify(null, Buffer.from(timestamp + raw), key, Buffer.from(signature, "hex"))
      )
        throw forbidden();
      body = JSON.parse(raw);
      if (body.application_id !== config.applicationId) throw forbidden();
      if (body.type === 1) return jsonResponse({ type: 1 });
    } else {
      body = JSON.parse(raw);
      await verifyTeams(config, headers.authorization ?? "", body);
    }
    const event = normalizeMessage(c, config, body);
    if (event) {
      await receive(event);
      if (c.provider === "telegram") await acknowledgeTelegram(config, event);
    }
    if (c.provider === "discord")
      return jsonResponse(
        event
          ? { type: 5, data: { flags: 64 } }
          : { type: 4, data: { content: "This command or channel is not enabled.", flags: 64 } },
      );
    return jsonResponse({});
  }
  async function acknowledgeDiscord(config: BotConfiguration, event: IncomingMessage) {
    try {
      await json(
        `https://discord.com/api/v10/interactions/${encode(event.id)}/${encode(event.reply!.token!)}/callback`,
        { type: 5, data: { flags: 64 } },
      );
    } catch (error) {
      // A replay after losing the defer response is safe: the original reply already exists.
      if (!(error instanceof ProviderRequestError && error.providerCode === 40060)) throw error;
    }
  }
  async function acknowledgeTelegram(config: BotConfiguration, event: IncomingMessage) {
    if (!event.reply?.callbackId) return;
    // This only clears the client's spinner. A duplicate/expired callback must not discard a durable command.
    try {
      await telegram(config, "answerCallbackQuery", { callback_query_id: event.reply.callbackId });
    } catch {
      /* diagnostics-ignore: An expired or duplicate spinner acknowledgement must not discard a durable command. */
      /* command remains queued */
    }
  }
  async function send(
    c: ChatAppConnection,
    config: BotConfiguration,
    event: IncomingMessage,
    message: ChatMessage,
    index = 0,
    locale: AppLocale = "en",
  ) {
    const text = message.text;
    const max = c.provider === "discord" ? 2000 : c.provider === "telegram" ? 4000 : 10000;
    const content =
      text.length > max ? `${text.slice(0, max - 200)}\n\n${chatCopy(locale).openFull}` : text;
    if (c.provider === "telegram")
      await telegram(config, "sendMessage", {
        chat_id: event.channelId,
        text: content,
        link_preview_options: { is_disabled: true },
        ...(message.buttons?.length
          ? {
              reply_markup: {
                inline_keyboard: message.buttons.map((button) => [
                  { text: button.label, callback_data: `os:${button.token}` },
                ]),
              },
            }
          : {}),
        ...(event.threadId ? { message_thread_id: Number(event.threadId) } : {}),
      });
    else if (c.provider === "slack")
      await json(
        `https://slack.com/api/${event.reply?.ephemeral ? "chat.postEphemeral" : "chat.postMessage"}`,
        {
          channel: event.channelId,
          text: content,
          mrkdwn: false,
          unfurl_links: false,
          unfurl_media: false,
          ...(event.reply?.ephemeral ? { user: event.userId } : {}),
          ...(event.threadId ? { thread_ts: event.threadId } : {}),
        },
        `Bearer ${config.credentials.botToken}`,
      );
    else if (c.provider === "discord")
      await json(
        `https://discord.com/api/v10/webhooks/${encode(config.applicationId!)}/${encode(event.reply!.token!)}${index === 0 ? "/messages/@original" : ""}`,
        { content, allowed_mentions: { parse: [] }, ...(index > 0 ? { flags: 64 } : {}) },
        undefined,
        index === 0 ? "PATCH" : "POST",
      );
    else {
      const token = await request(
        `https://login.microsoftonline.com/${encode(config.workspaceId!)}/oauth2/v2.0/token`,
        {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: config.applicationId!,
            client_secret: config.credentials.clientSecret!,
            scope: "https://api.botframework.com/.default",
          }),
        },
      );
      if (!token.access_token) throw fail("Teams authentication failed.", 502);
      await json(
        `${teamsUrl(config.serviceUrl!)}/v3/conversations/${encode(event.channelId)}/activities/${encode(event.reply?.activityId ?? event.id)}`,
        { type: "message", text: content, textFormat: "plain", replyToId: event.id },
        `Bearer ${token.access_token}`,
      );
    }
  }
  return {
    configure,
    activate,
    forward,
    send,
    telegram,
    acknowledgeDiscord,
    acknowledgeTelegram,
    normalize: normalizeMessage,
  };
}
