import { reportCaughtError } from "@repo/core/diagnostics";
import { chatLocale } from "../chat-locale";
import { repos, type ChatAppConnection } from "@repo/db";
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import { enabled, fail, fingerprint, nonce } from "../chat-apps-common";
import { createChatProviders } from "./providers";
import { createReceivers } from "./receivers";
import type {
  BotConfiguration,
  ChatTransport,
  IncomingMessage,
  ProviderFetch,
  ReceiverFactory,
  ReceiverStatus,
} from "./types";

export const directConnectionId = (id: string) => `openship:${id}`;

export function createDirectChatTransport(
  options: { fetch?: ProviderFetch; receiver?: ReceiverFactory } = {},
): ChatTransport {
  const providers = createChatProviders(options.fetch);
  const receive = options.receiver ?? createReceivers(options.fetch);
  const owner = nonce();
  const menus = new Map<string, string>();
  async function syncMenu(c: ChatAppConnection) {
    const locale = await chatLocale(c);
    const key = `${c.revision}:${locale}`;
    if (menus.get(c.id) === key) return;
    await providers.activate(c, await config(c), locale);
    menus.set(c.id, key);
  }
  const workers = new Map<
    string,
    {
      revision: number;
      controller: AbortController;
      task: Promise<void>;
      deadline: ReturnType<typeof setTimeout>;
      status: ReceiverStatus;
      finished: boolean;
      retryAt: number;
    }
  >();
  async function config(c: ChatAppConnection): Promise<BotConfiguration> {
    const row = await repos.chatApps.transport(c.id);
    if (!row) throw fail("Reconnect this bot in its connection settings.", 409);
    return JSON.parse(decrypt(row.configuration));
  }
  async function stop(c: Pick<ChatAppConnection, "id">) {
    const worker = workers.get(c.id);
    if (worker) {
      clearTimeout(worker.deadline);
      worker.controller.abort();
      await worker.task;
      workers.delete(c.id);
    }
    await repos.chatApps.releaseReceiver(c.id, owner);
  }
  async function enqueue(
    c: ChatAppConnection,
    event: IncomingMessage,
    receiverOwner: string | null,
  ) {
    if (
      !(await repos.chatApps.enqueue(c, receiverOwner, {
        id: fingerprint([c.id, event.id]),
        payload: encrypt(JSON.stringify(event)),
        state: c.provider === "discord" && receiverOwner ? "awaiting_ack" : "pending",
      }))
    )
      throw fail("The connection changed before this message was saved.", 409);
  }
  return {
    async configure(c, settings) {
      const previous = await repos.chatApps.transport(c.id);
      const old: BotConfiguration | undefined = previous
        ? JSON.parse(decrypt(previous.configuration))
        : undefined;
      const credentials = {
        ...old?.credentials,
        ...Object.fromEntries(Object.entries(settings.credentials).filter(([, value]) => value)),
      };
      const next = await providers.configure(c, { ...settings, credentials });
      // An identity, not the token, prevents two tenants from competing for the same bot.
      const botKey = fingerprint([
        c.provider,
        next.botId,
        c.provider === "slack" ? next.workspaceId : "",
      ]);
      await stop(c);
      try {
        await repos.chatApps.saveTransport(c.id, encrypt(JSON.stringify(next)), botKey);
      } catch {
        throw fail(
          "This bot is already connected, or its settings could not be saved. Use a separate bot for each connection.",
          409,
        );
      }
    },
    async configuration(c) {
      const value = await config(c);
      return {
        channelIds: value.channelIds,
        workspaceId: value.workspaceId,
        applicationId: value.applicationId,
        serviceUrl: value.serviceUrl,
      };
    },
    async activate(c) {
      await syncMenu(c);
    },
    stop,
    async poll(c) {
      await syncMenu(c);
      if (c.transport !== "outbound") return { state: "connected" };
      let worker = workers.get(c.id);
      if (worker && worker.revision !== c.revision) {
        await stop(c);
        worker = undefined;
      }
      const lease = await repos.chatApps.acquireReceiver(c.id, c.revision, owner);
      if (!lease) {
        if (worker) await stop(c);
        return { state: "connecting" };
      }
      if (worker && !worker.finished) {
        clearTimeout(worker.deadline);
        worker.deadline = setTimeout(() => worker!.controller.abort(), 25000);
        worker.deadline.unref();
        return worker.status;
      }
      if (worker && worker.retryAt > Date.now()) return worker.status;
      const configuration = await config(c);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 25000);
      deadline.unref();
      const next = {
        revision: c.revision,
        controller,
        deadline,
        task: Promise.resolve(),
        status: { state: "connecting" } as ReceiverStatus,
        finished: false,
        retryAt: 0,
      };
      workers.set(c.id, next);
      next.task = receive(c, configuration, {
        signal: controller.signal,
        cursor: lease.cursor ? decrypt(lease.cursor) : null,
        receive: (event) => enqueue(c, event, owner),
        async acknowledged(id) {
          await enabled(c.id, c.revision);
          await repos.chatApps.acknowledgeInbox(c.id, fingerprint([c.id, id]), c.revision);
        },
        async saveCursor(cursor) {
          if (
            controller.signal.aborted ||
            !(await repos.chatApps.saveReceiverCursor(c.id, owner, encrypt(cursor)))
          )
            throw fail("Chat receiver lease expired.");
        },
        status(status) {
          next.status = status;
        },
      })
        .catch(() => {
          if (!controller.signal.aborted)
            reportCaughtError(
              new Error("Chat app background operation failed"),
              "api/modules/chat-apps/transport/direct",
            );
          next.status = {
            state: "retrying",
            error: "Check the bot credentials, provider setup and internet connection.",
          };
        })
        .finally(() => {
          clearTimeout(next.deadline);
          next.finished = true;
          next.retryAt = Date.now() + 15000;
        });
      return next.status;
    },
    async claim(c) {
      const row = await repos.chatApps.claimInbox(c.id, c.revision, nonce());
      if (!row) return null;
      const event = JSON.parse(decrypt(row.payload)) as IncomingMessage;
      const { reply: _, id: providerId, ...sender } = event;
      return {
        ...sender,
        id: row.id,
        integrationId: c.nativeId!,
        revision: c.revision,
        lease: row.lease!,
      };
    },
    async complete(c, event, reply) {
      if (!reply.messages.length || reply.messages.length > 8) throw fail("Invalid chat reply.");
      for (;;) {
        await enabled(c.id, c.revision);
        const row = await repos.chatApps.beginDelivery(c.id, event.id, c.revision, event.lease);
        if (!row) {
          const existing = await repos.chatApps.inboxEvent(event.id);
          if (
            existing?.connectionId === c.id &&
            existing.revision === c.revision &&
            ["sending", "done"].includes(existing.state)
          )
            return;
          throw fail("This chat delivery expired or changed.", 409);
        }
        const index = row.deliveredCount;
        const message = reply.messages[index];
        if (!message) throw fail("Chat reply changed during delivery.");
        // Fence each individual message before network I/O. An ambiguous send is never replayed.
        await providers.send(
          c,
          await config(c),
          JSON.parse(decrypt(row.payload)),
          message,
          index,
          await chatLocale(c, event),
        );
        const final = index === reply.messages.length - 1;
        if (!(await repos.chatApps.delivered(row.id, event.lease, index, final)))
          throw fail("Chat delivery changed.", 409);
        if (final) return;
      }
    },
    async forward(c, body, headers) {
      return providers.forward(c, await config(c), body, headers, (event) =>
        enqueue(c, event, null),
      );
    },
    async remove(c) {
      await stop(c);
      menus.delete(c.id);
    }, // The owning connection deletion cascades encrypted storage.
    async sweep(active) {
      for (const id of menus.keys()) if (!active.some((c) => c.id === id)) menus.delete(id);
      await Promise.all(
        [...workers.keys()]
          .filter(
            (id) => !active.some((c) => c.id === id && c.revision === workers.get(id)?.revision),
          )
          .map((id) => stop({ id })),
      );
    },
    async close() {
      await Promise.all([...workers.keys()].map((id) => stop({ id })));
    },
  };
}
