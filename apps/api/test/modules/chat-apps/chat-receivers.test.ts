import { describe, expect, it, vi } from "vitest";
import type { ChatAppConnection } from "@repo/db";
import type {
  BotConfiguration,
  ReceiverFactory,
} from "../../../src/modules/chat-apps/transport/types";
const sdk = vi.hoisted(() => ({ slack: [] as any[], discord: [] as any[] }));
vi.mock("@slack/socket-mode", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    SocketModeClient: class extends EventEmitter {
      constructor(public options: any) {
        super();
        sdk.slack.push(this);
      }
      async start() {
        this.emit("connected");
      }
      disconnect = vi.fn(async () => {});
    },
  };
});
vi.mock("@discordjs/rest", () => ({
  REST: class {
    setToken() {
      return this;
    }
  },
}));
vi.mock("@discordjs/ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    WebSocketShardEvents: {
      Dispatch: "dispatch",
      Ready: "ready",
      Resumed: "resumed",
      Closed: "closed",
      Error: "error",
    },
    WebSocketManager: class extends EventEmitter {
      constructor(public options: any) {
        super();
        sdk.discord.push(this);
      }
      async connect() {
        this.emit("ready", { application: { id: "300" } });
      }
      destroy = vi.fn(async () => {});
    },
  };
});
import { createReceivers } from "../../../src/modules/chat-apps/transport/receivers";
const configuration: BotConfiguration = {
  channelIds: ["100"],
  workspaceId: "200",
  applicationId: "300",
  botId: "300",
  credentials: { botToken: "123:fixture", appToken: "xapp-fixture" },
};
function host() {
  const controller = new AbortController();
  const hooks: Parameters<ReceiverFactory>[2] = {
    signal: controller.signal,
    receive: vi.fn(async () => {}),
    acknowledged: vi.fn(async () => {}),
    cursor: null,
    saveCursor: vi.fn(async () => {}),
    status: vi.fn(),
  };
  return { controller, hooks };
}
const connection = (provider: string) =>
  ({ id: "bot", provider, purpose: "commands", assistantAllowed: false }) as ChatAppConnection;

describe("Outbound provider adapters", () => {
  it("persists Telegram messages before advancing the polling cursor and stops on cancellation", async () => {
    const { controller, hooks } = host(),
      order: string[] = [],
      requests: any[] = [];
    hooks.receive = vi.fn(async () => {
      order.push("persist");
    });
    hooks.saveCursor = vi.fn(async () => {
      order.push("cursor");
    });
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1)
        return Response.json({
          ok: true,
          result: [
            { update_id: 100, message: { text: "/projects", from: { id: 42 }, chat: { id: 100 } } },
          ],
        });
      await new Promise<void>((resolve) =>
        init?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("aborted");
    });
    const running = createReceivers(fetcher)(connection("telegram"), configuration, hooks).catch(
      () => {},
    );
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(order).toEqual(["persist", "cursor"]);
    expect(requests[1].offset).toBe(101);
    expect(hooks.status).toHaveBeenCalledWith({ state: "connected" });
    controller.abort();
    await running;
  });

  it("does not acknowledge a Telegram update when durable enqueue fails", async () => {
    const { hooks } = host();
    hooks.receive = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const fetcher = vi.fn(async () =>
      Response.json({
        ok: true,
        result: [{ update_id: 1, message: { text: "/help", from: { id: 42 }, chat: { id: 100 } } }],
      }),
    );
    await expect(
      createReceivers(fetcher)(connection("telegram"), configuration, hooks),
    ).rejects.toThrow("database unavailable");
    expect(hooks.saveCursor).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("receives Slack's SDK envelope and acknowledges only after it is saved", async () => {
    const { controller, hooks } = host();
    let saved!: () => void;
    hooks.receive = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    const running = createReceivers()(connection("slack"), configuration, hooks);
    await vi.waitFor(() => expect(sdk.slack.length).toBeGreaterThan(0));
    const client = sdk.slack.at(-1),
      ack = vi.fn(async () => {});
    client.emit("slack_event", {
      body: {
        command: "/openship-projects",
        text: "",
        team_id: "200",
        user_id: "42",
        channel_id: "100",
        trigger_id: "unique",
      },
      ack,
    });
    await vi.waitFor(() => expect(hooks.receive).toHaveBeenCalled());
    expect(ack).not.toHaveBeenCalled();
    saved();
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
    controller.abort();
    await running;
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it("defers Discord privately after persistence and marks it ready before checkpointing the session", async () => {
    const { controller, hooks } = host(),
      order: string[] = [];
    hooks.receive = vi.fn(async () => {
      order.push("persist");
    });
    hooks.acknowledged = vi.fn(async () => {
      order.push("ready");
    });
    hooks.saveCursor = vi.fn(async () => {
      order.push("cursor");
    });
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ type: 5, data: { flags: 64 } });
      order.push("defer");
      return new Response(null, { status: 204 });
    });
    const running = createReceivers(fetcher)(connection("discord"), configuration, hooks);
    await vi.waitFor(() => expect(sdk.discord.length).toBeGreaterThan(0));
    const manager = sdk.discord.at(-1);
    expect(manager.options.intents).toBe(0);
    manager.options.updateSessionInfo(0, {
      sequence: 7,
      sessionId: "session",
      resumeURL: "wss://gateway.discord.gg",
      shardCount: 1,
      shardId: 0,
    });
    manager.emit("dispatch", {
      s: 7,
      t: "INTERACTION_CREATE",
      d: {
        type: 2,
        id: "123",
        application_id: "300",
        guild_id: "200",
        channel_id: "100",
        member: { user: { id: "42" } },
        token: "private_reply",
        data: { name: "openship", options: [{ name: "projects", type: 1 }] },
      },
    });
    await vi.waitFor(() => expect(hooks.saveCursor).toHaveBeenCalled());
    expect(order).toEqual(["persist", "defer", "ready", "cursor"]);
    expect(JSON.parse((hooks.saveCursor as any).mock.calls[0][0]).sequence).toBe(7);
    controller.abort();
    await running;
    expect(manager.destroy).toHaveBeenCalledTimes(1);
  });
});
