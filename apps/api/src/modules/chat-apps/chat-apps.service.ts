import { reportCaughtError } from "@repo/core/diagnostics";
import type { ChatReply } from "./chat-reply";
import { repos, type ChatAppConnection } from "@repo/db";
import type {
  ChatAppCreate,
  ChatAppsStatus,
  ChatAppView,
  ChatAssistantInput,
  AssistantProvider,
  ChatAppPurpose,
  ChatAppUpdate,
  ChatAppConfiguration,
} from "@repo/contracts";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { captureExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import type { RequestContext } from "../../lib/request-context";
import { createProvisionLock } from "@repo/platform/engine/lib/provision-lock";
import { createDirectChatTransport, directConnectionId } from "./transport/direct";
import type { ChatTransport, HostEvent } from "./transport/types";
import { AppError } from "@repo/core";
import { createChatCommands } from "./chat-apps-commands";
import { enabled, fail, fingerprint, nonce, owned, session } from "./chat-apps-common";
import { unlinkIdentity } from "./chat-apps-access";
import { createChatAssistant } from "./chat-assistant";
import { assistant, type createAssistantRuntime } from "../assistant/assistant.service";
import { assistantCredential } from "../assistant/assistant-access";
import { mcpClientToken } from "../mcp/mcp-client-authorization";
const lock = <T>(id: string, work: () => Promise<T>) =>
  createProvisionLock(`chat-connection:${id}`).run(work);
function validateTransport(
  provider: ChatAppView["provider"],
  transport: ChatAppView["transport"],
  origin: string,
) {
  if (transport === "outbound" && provider === "teams")
    throw fail(
      "Microsoft Teams requires a public HTTPS bot endpoint. Choose a webhook connection.",
      400,
    );
  if (transport === "webhook" && new URL(origin).protocol !== "https:")
    throw fail(
      "Webhook connections require a public HTTPS API URL. Use an outbound connection for a local installation.",
      400,
    );
}
export function createChatApps(
  transport: ChatTransport = createDirectChatTransport(),
  runtime: ReturnType<typeof createAssistantRuntime> = assistant,
) {
  const commands = createChatCommands(undefined, createChatAssistant(runtime));
  const issues = new Map<string, string>();
  const receivers = new Map<string, ChatAppView["receiver"]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let lastPruned = 0;
  async function view(c: ChatAppConnection, userId: string): Promise<ChatAppView> {
    const identity = (await repos.chatApps.identities(c.id)).find((i) => i.userId === userId);
    return {
      id: c.id,
      name: c.name,
      provider: c.provider as ChatAppView["provider"],
      purpose: c.purpose,
      transport: c.transport,
      receiver:
        c.transport === "outbound"
          ? c.enabled
            ? (receivers.get(c.id) ?? { state: "connecting" })
            : { state: "paused" }
          : undefined,
      enabled: c.enabled,
      revision: c.revision,
      serverId: c.serverId,
      webhookUrl: c.transport === "webhook" ? `${c.origin}/api/chat-apps/webhooks/${c.id}` : "",
      linked: !!identity,
      identityId: identity?.id ?? null,
      assistantAllowed: c.assistantAllowed,
      assistantRevision: identity?.assistantRevision ?? null,
      assistant: identity?.assistantProvider
        ? {
            provider: identity.assistantProvider as AssistantProvider,
            model: identity.assistantModel,
          }
        : null,
      issue: !c.nativeId
        ? "Setup did not finish. Remove this paused connector before trying again."
        : issues.get(c.id),
    };
  }
  async function tick() {
    if (Date.now() - lastPruned > 3600000) {
      await repos.chatApps.prune();
      lastPruned = Date.now();
    }
    const connections = await repos.chatApps.active();
    await transport.sweep(connections);
    // Bounded parallelism, with a database lock for each connection across API replicas.
    for (let i = 0; i < connections.length && !stopped; i += 4) {
      await Promise.allSettled(
        connections.slice(i, i + 4).map(async (snapshot) => {
          try {
            await lock(snapshot.id, async () => {
              const c = await enabled(snapshot.id, snapshot.revision);
              const receiver = await transport.poll(c);
              if (c.transport === "outbound") receivers.set(c.id, receiver);
              async function deliver(event: HostEvent, text: ChatReply | null) {
                if (text === null) return;
                await enabled(c.id, c.revision);
                await transport.complete(c, event, text);
                await repos.chatApps.updateDelivery(fingerprint([c.id, event.id]), null);
              }
              // Assistant turns finish independently. Poll their durable receipts without
              // blocking new messages or stop commands for the connector.
              for (const pending of await repos.chatApps.pendingReplies(c.id)) {
                const event = JSON.parse(decrypt(pending.delivery!)) as HostEvent;
                try {
                  await deliver(event, await commands.handle(c, event));
                } catch (error) {
                  // Expired host claims are reclaimed below with a new lease; never rerun the turn.
                  if (!(error instanceof AppError && [403, 409, 404].includes(error.statusCode)))
                    throw error;
                }
              }
              for (let n = 0; n < 5 && !stopped; n++) {
                const event = await transport.claim(c);
                if (!event) break;
                const text = await commands.handle(c, event);
                await deliver(event, text);
              }
              issues.delete(c.id);
            });
          } catch {
            reportCaughtError(
              new Error("Chat app background operation failed"),
              "api/modules/chat-apps/chat-apps.service",
            );
            receivers.delete(snapshot.id);
            issues.set(
              snapshot.id,
              "Could not reach the chat provider. Check this bot’s credentials and connection settings.",
            );
          }
        }),
      );
    }
  }
  async function updateConnection(
    ctx: RequestContext,
    id: string,
    revision: number,
    patch: { enabled?: boolean; assistantAllowed?: boolean; purpose?: ChatAppPurpose },
    settings?: ChatAppUpdate,
    refreshCommands = false,
  ) {
    return lock(id, async () => {
      const c = await owned(ctx, id, true);
      if (c.revision !== revision)
        throw fail("This connection changed. Refresh before updating it.");
      if (!c.nativeId) throw fail("Connection setup is incomplete.");
      const value = patch.enabled ?? c.enabled;
      if (refreshCommands && !value)
        throw fail("Enable this bot before refreshing its command menu.", 400);
      const purpose = patch.purpose ?? c.purpose;
      const method = settings?.transport ?? c.transport;
      if (settings) validateTransport(c.provider as ChatAppView["provider"], method, c.origin);
      if (settings && !settings.name.trim()) throw fail("Enter a connection name.", 400);
      if (patch.assistantAllowed && purpose === "commands")
        throw fail("Choose an assistant or combined bot before allowing assistant chats.", 400);
      const assistantAllowed =
        purpose !== "commands" && (patch.assistantAllowed ?? c.assistantAllowed);
      // Pause the authorization gate before any external I/O. An interrupted change stays paused.
      const saved = await repos.chatApps.update(id, revision, {
        enabled: false,
        assistantAllowed,
        purpose,
      });
      if (!saved) throw fail("Connection changed.");
      try {
        await transport.stop(c);
        const configured = {
          ...saved,
          transport: method,
          ...(settings ? { nativeId: directConnectionId(id) } : {}),
        };
        if (settings) await transport.configure({ ...configured, nativeId: c.nativeId }, settings);
        if (value) await transport.activate(configured);
        const updated = await repos.chatApps.update(id, saved.revision, {
          enabled: value,
          transport: method,
          nativeId: configured.nativeId,
          ...(settings ? { name: settings.name.trim() } : {}),
        });
        if (!updated) throw fail("Connection changed.");
        issues.delete(id);
        receivers.delete(id);
        return view(updated, ctx.userId);
      } catch (error) {
        const message =
          error instanceof AppError
            ? error.message
            : "Check the bot credentials and provider permissions, then retry.";
        issues.set(id, `The connection is paused. ${message}`);
        throw fail(`The connection is paused. ${message}`, 502);
      }
    });
  }
  return {
    async configuration(ctx: RequestContext, id: string): Promise<ChatAppConfiguration> {
      return lock(id, async () => {
        const c = await owned(ctx, id, true);
        if (!c.nativeId) throw fail("Connection setup is incomplete.");
        const spec = await transport.configuration(c);
        // Explicitly select editable metadata. Never return provider credentials or native internals.
        return {
          ...(await view(c, ctx.userId)),
          channelIds: spec.channelIds,
          workspaceId: spec.workspaceId,
          applicationId: spec.applicationId,
          serviceUrl: spec.serviceUrl,
        };
      });
    },
    async configure(ctx: RequestContext, id: string, input: ChatAppUpdate) {
      return updateConnection(
        ctx,
        id,
        input.revision,
        {
          purpose: input.purpose,
          assistantAllowed: input.purpose !== "commands",
        },
        input,
      );
    },
    async syncCommands(ctx: RequestContext, id: string, revision: number) {
      // Reuse the same guarded configuration update and role-filtered catalog.
      return updateConnection(ctx, id, revision, {}, undefined, true);
    },
    async status(ctx: RequestContext): Promise<ChatAppsStatus> {
      // Read-only metadata uses the route's ordinary settings:read authorization.
      // All credential/consent/mutation methods retain their session-only gate.
      const canManage = ctx.role === "owner" || ctx.role === "admin";
      return {
        organizationId: ctx.organizationId,
        connections: await Promise.all(
          (await repos.chatApps.list(ctx.organizationId)).map((c) => view(c, ctx.userId)),
        ),
        canManage,
      };
    },
    async create(ctx: RequestContext, origin: string, input: ChatAppCreate) {
      session(ctx, true);
      const method = input.transport ?? (input.provider === "teams" ? "webhook" : "outbound");
      validateTransport(input.provider, method, origin);
      if (!input.name.trim()) throw fail("Enter a connection name.", 400);
      if ((await repos.chatApps.list(ctx.organizationId)).length >= 20)
        throw fail("This workspace already has 20 chat connections.");
      const c: ChatAppConnection = {
        id: nonce(),
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        serverId: null,
        name: input.name.trim(),
        provider: input.provider,
        transport: method,
        purpose: input.purpose ?? "commands",
        origin,
        enabled: false,
        assistantAllowed: !!input.purpose && input.purpose !== "commands",
        nativeId: null,
        revision: 1,
        createdAt: new Date(),
      };
      await repos.chatApps.create(c);
      try {
        await transport.configure(c, input);
        const saved = await repos.chatApps.update(c.id, c.revision, {
          nativeId: directConnectionId(c.id),
        });
        if (!saved) throw fail("Connection changed. Refresh and retry.");
        return view(saved, ctx.userId);
      } catch (error) {
        // No receiver is started during setup; this transaction has no remote installation to leak.
        await repos.chatApps.remove(c.id);
        if (error instanceof AppError) throw error;
        throw fail("The bot could not be connected. Check its credentials and allowed chats.", 502);
      }
    },
    async setEnabled(ctx: RequestContext, id: string, value: boolean, revision: number) {
      return updateConnection(ctx, id, revision, { enabled: value });
    },
    async setAssistantAllowed(ctx: RequestContext, id: string, value: boolean, revision: number) {
      return updateConnection(ctx, id, revision, { assistantAllowed: value });
    },
    async setPurpose(ctx: RequestContext, id: string, purpose: ChatAppPurpose, revision: number) {
      return updateConnection(ctx, id, revision, {
        purpose,
        assistantAllowed: purpose !== "commands",
      });
    },
    async configureAssistant(ctx: RequestContext, id: string, input: ChatAssistantInput) {
      const c = await owned(ctx, id);
      return createProvisionLock(`chat-assistant-settings:${input.identityId}`).run(async () => {
        const identity = await repos.chatApps.identityById(input.identityId);
        if (!identity || identity.connectionId !== c.id || identity.userId !== ctx.userId)
          throw fail("Link your own chat account first.", 403);
        if (input.enabled && (!c.enabled || !c.assistantAllowed || c.purpose === "commands"))
          throw fail("A workspace admin must allow assistant chats first.");
        let fingerprint: string | null = null;
        let authority = null;
        if (input.enabled) {
          if (!input.provider) throw fail("Choose your connected agent.", 400);
          await mcpClientToken({ ...identity, organizationId: c.organizationId, origin: c.origin });
          const access = await assistantCredential(ctx);
          const info = await runtime.provider(ctx, input.provider);
          if (!info.available || !info.authStatus.configured)
            throw fail("Connect this agent in Assistant → Your agents first.");
          if (input.model && !info.models.some((m) => m.id === input.model))
            throw fail("Choose an available model.", 400);
          fingerprint = access.fingerprint;
          authority = await captureExecutionAuthority(ctx);
        }
        const updated = await repos.chatApps.configureAssistant(
          identity.id,
          ctx.userId,
          input.revision,
          {
            assistantProvider: input.enabled ? input.provider! : null,
            assistantModel: input.enabled ? (input.model ?? "") : "",
            assistantAuthority: authority,
            assistantFingerprint: fingerprint,
          },
        );
        if (!updated) throw fail("Your chat connection changed. Refresh and try again.");
        return view(c, ctx.userId);
      });
    },
    async remove(ctx: RequestContext, id: string) {
      return lock(id, async () => {
        const c = await owned(ctx, id, true);
        await repos.chatApps.update(id, c.revision, { enabled: false });
        await transport.remove(c);
        for (const identity of await repos.chatApps.identities(id))
          await unlinkIdentity(identity.id, identity.userId);
        await repos.chatApps.remove(id);
        issues.delete(id);
        receivers.delete(id);
      });
    },
    async unlink(ctx: RequestContext, id: string) {
      const c = await owned(ctx, id);
      for (const identity of await repos.chatApps.identities(c.id))
        if (identity.userId === ctx.userId) await unlinkIdentity(identity.id, ctx.userId);
    },
    async forward(id: string, body: string, headers: Record<string, string>) {
      const c = await enabled(id);
      if (c.transport === "outbound") throw fail("This connector does not accept webhooks.", 404);
      return transport.forward(c, body, headers);
    },
    tick,
    start() {
      if (timer || stopped) return;
      const schedule = () => {
        timer = setTimeout(() => {
          running = tick()
            .catch(() => {
              reportCaughtError(
                new Error("Chat app background operation failed"),
                "api/modules/chat-apps/chat-apps.service",
              );
            })
            .finally(() => {
              running = undefined;
              if (!stopped) schedule();
            });
        }, 5000);
        timer.unref();
      };
      schedule();
    },
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
      await transport.close();
    },
  };
}
export const chatApps = createChatApps();
