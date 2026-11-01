import { setTimeout as delay } from "node:timers/promises";
import { createChatProviders, normalizeMessage, silentLogger } from "./providers";
import type { ProviderFetch, ReceiverFactory } from "./types";

/** Provider SDKs own reconnect/heartbeat behavior; OpenShip owns authorization and receipts. */
export function createReceivers(fetcher?: ProviderFetch): ReceiverFactory {
  const providers = createChatProviders(fetcher);
  return async (c, config, hooks) => {
    const { signal } = hooks;
    if (signal.aborted) return;
    if (c.provider === "telegram") {
      let offset = Number(hooks.cursor ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
      while (!signal.aborted) {
        const response = await providers.telegram(
          config,
          "getUpdates",
          { offset, timeout: 10, limit: 100, allowed_updates: ["message", "callback_query"] },
          signal,
        );
        if (!Array.isArray(response.result)) throw new Error("Invalid polling response");
        hooks.status({ state: "connected" });
        for (const update of response.result) {
          if (signal.aborted) return;
          if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
          const event = normalizeMessage(c, config, update);
          if (event) {
            await hooks.receive(event);
            await providers.acknowledgeTelegram(config, event);
          }
          offset = update.update_id + 1;
          // Acknowledge only after the verified delivery is durable (or deliberately ignored).
          await hooks.saveCursor(String(offset));
        }
        if (!response.result.length) await delay(250, undefined, { signal });
      }
      return;
    }
    if (c.provider === "slack") {
      const { SocketModeClient } = await import("@slack/socket-mode");
      if (signal.aborted) return;
      const client = new SocketModeClient({
        appToken: config.credentials.appToken!,
        logger: silentLogger as any,
      });
      let fail: (e: Error) => void = () => {};
      const closed = new Promise<void>((resolve, reject) => {
        fail = reject;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      client.on("connected", () => hooks.status({ state: "connected" }));
      client.on("reconnecting", () => hooks.status({ state: "retrying" }));
      client.on("error", () => {
        /* diagnostics-ignore: Reject the lifecycle promise; the receiver boundary records a safe retry summary. */ return fail(
          new Error("Slack connection failed"),
        );
      });
      client.on("slack_event", ({ body, ack }: any) => {
        void (async () => {
          if (signal.aborted) return;
          const event = normalizeMessage(c, config, body);
          if (event) await hooks.receive(event);
          await ack();
        })().catch(() => {
          /* diagnostics-ignore: Forward delivery failure to the observed receiver lifecycle. */ return fail(
            new Error("Slack delivery could not be saved"),
          );
        });
      });
      try {
        await Promise.race([client.start(), closed]);
        await closed;
      } finally {
        await client.disconnect();
      }
      return;
    }
    if (c.provider === "discord") {
      const [{ WebSocketManager, WebSocketShardEvents }, { REST }] = await Promise.all([
        import("@discordjs/ws"),
        import("@discordjs/rest"),
      ]);
      if (signal.aborted) return;
      let session: import("@discordjs/ws").SessionInfo | null = hooks.cursor
        ? JSON.parse(hooks.cursor)
        : null;
      let failed = false;
      let fail: (e: Error) => void = () => {};
      const closed = new Promise<void>((resolve, reject) => {
        fail = (e) => {
          failed = true;
          reject(e);
        };
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      const manager = new WebSocketManager({
        token: config.credentials.botToken!,
        intents: 0,
        rest: new REST({ retries: 0, timeout: 15000 }).setToken(config.credentials.botToken!),
        shardCount: 1,
        shardIds: [0],
        retrieveSessionInfo: () => session,
        updateSessionInfo: (_id, value) => {
          session = value;
        },
      });
      let processing = Promise.resolve();
      manager.on(WebSocketShardEvents.Dispatch, (packet) => {
        const cursor = session ? JSON.stringify({ ...session, sequence: packet.s }) : null;
        processing = processing
          .then(async () => {
            if (failed || signal.aborted) return;
            if (packet.t === "INTERACTION_CREATE") {
              const event = normalizeMessage(c, config, packet.d);
              if (event) {
                await hooks.receive(event);
                await providers.acknowledgeDiscord(config, event);
                await hooks.acknowledged(event.id);
              }
            }
            if (cursor) await hooks.saveCursor(cursor);
          })
          .catch(() => {
            /* diagnostics-ignore: Reject the lifecycle promise; the receiver boundary records a safe summary. */ fail(
              new Error("Discord delivery could not be saved"),
            );
          });
      });
      manager.on(WebSocketShardEvents.Ready, (data) => {
        if (data.application.id !== config.applicationId)
          fail(new Error("Discord application mismatch"));
        else hooks.status({ state: "connected" });
      });
      manager.on(WebSocketShardEvents.Resumed, () => hooks.status({ state: "connected" }));
      manager.on(WebSocketShardEvents.Closed, () => hooks.status({ state: "retrying" }));
      manager.on(WebSocketShardEvents.Error, () => fail(new Error("Discord connection failed")));
      try {
        await Promise.race([manager.connect(), closed]);
        await closed;
      } finally {
        await manager.destroy();
        await processing;
      }
      return;
    }
    throw new Error("This provider requires webhooks");
  };
}
