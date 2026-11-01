import { captureExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import { nativeAgents } from "@repo/platform/engine/modules/assistant/native-agents";
import { ownedAgent, validateAgentGrants } from "./agent-access";
import { prepareTaskAccess, releaseTaskAccess } from "./task-access";
import { appLocale } from "@repo/core";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { env } from "@repo/platform/engine/config/env";
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import {
  assistantTargets,
  localAssistantTarget,
} from "@repo/platform/engine/modules/assistant/target-access";
import {
  createRemoteAssistantClient,
  assistantProfileKey,
} from "@repo/platform/engine/modules/assistant/remote-target";
import {
  ApiError,
  type AuthMethod,
  type AuthState,
  type Interaction,
  type MessagePage,
  type Message,
  type QuestionAnswer,
  type Run,
} from "@repo/platform/engine/modules/assistant/native-target";
import { repos, type AssistantRow } from "@repo/db";
import {
  appendAssistantEvents,
  assistantFieldInput,
  assistantImagesError,
  isAssistantActive,
  type AssistantActivity,
  type AssistantConversation,
  type AssistantEvent,
  type AssistantMessage,
  type AssistantProvider,
  type AssistantProviderInfo,
  type AssistantRunState,
  type AssistantSnapshot,
  type AssistantTurnInput,
} from "@repo/contracts";
import { reportCaughtError } from "@repo/core/diagnostics";
import {
  createAssistantClient,
  type AssistantClientFactory,
  type AssistantNativeClient,
} from "@repo/platform/engine/modules/assistant/native-target";
import {
  HARNESS,
  PROVIDERS,
  SAFE_SETTINGS,
  scopedTurnOptions,
} from "@repo/platform/engine/modules/assistant/harness-policy";
import {
  assistantEvent,
  assistantFailure,
  assistantMessages,
} from "@repo/platform/engine/modules/assistant/presentation";
import { app } from "../../app";
import type { RequestContext } from "../../lib/request-context";
import {
  assistantAvailable,
  assistantCredential,
  assistantError,
  digest,
  disableAssistantAccess,
  ownerKey,
  requireAssistantSession,
  withAssistantLock,
} from "./assistant-access";
import { createAssistantBridge } from "./assistant-bridge";
import { assistantExecutionCredential } from "./execution-access";
import { validateChatConversation } from "../chat-apps/chat-assistant-access";
import { assistantImageHistory } from "./assistant-image-history";

/** Internal origins cannot be supplied by the public conversation routes. */
type ConversationSource =
  | { automationRunId: string }
  | { chatThreadId: string; id?: string }
  | { id: string };

interface LiveRun {
  row: AssistantRow;
  id: string;
  requestId: string;
  state: AssistantRunState;
  controller: AbortController;
  run?: Run;
  events: AssistantEvent[];
  sizes: number[];
  bytes: number;
  sequence: number;
  messages: AssistantMessage[];
  history: Pick<MessagePage, "before" | "hasMore">;
  listeners: Set<() => void>;
  error?: string;
  finished?: Promise<void>;
  token?: string;
  watchdog?: ReturnType<typeof setInterval>;
}
const complete = (state: string) => ["done", "error", "cancelled"].includes(state);
export const assistantQuestionRequestId = (id: string) => `question:${digest(id)}`;
const isQuestion = (interaction: Interaction) =>
  ["form", "input", "choice", "select"].includes(interaction.kind) &&
  Boolean(interaction.questions?.length);
const quiet = (row: AssistantRow): AssistantActivity => ({
  runId: row.runId,
  state: row.state as AssistantRunState,
  cursor: 0,
  events: [],
  reset: false,
  ...(row.state === "error" ? { error: assistantFailure() } : {}),
});
const publicConversation = (row: AssistantRow): AssistantConversation => ({
  id: row.id,
  title: row.title,
  provider: row.provider as AssistantProvider,
  model: row.model,
  state: row.state as AssistantRunState,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  agentId: row.agentId,
  agentRevision: row.agentRevision,
  automationRunId: row.automationRunId,
  chatThreadId: row.chatThreadId,
});

/** Host orchestration only. All product operations go through the public MCP endpoint unchanged. */
export function createAssistantRuntime(
  factory: AssistantClientFactory = (connection) =>
    connection.serverId
      ? createRemoteAssistantClient(connection)
      : createAssistantClient(
          join(process.env.OPENSHIP_DATA_DIR ?? join(homedir(), ".openship"), "assistants"),
          assistantProfileKey(connection),
          env.DEPLOY_MODE === "desktop" ? "host" : "private",
        ),
) {
  const workerId = randomUUID();
  const profiles = new Map<string, Promise<AssistantNativeClient>>();
  const touched = new Map<string, { at: number; owner: string }>();
  const live = new Map<string, LiveRun>();
  let idleProfiles: ReturnType<typeof setInterval> | undefined;
  function watchProfiles() {
    if (idleProfiles) return;
    idleProfiles = setInterval(() => {
      for (const [key, use] of touched) {
        if (Date.now() - use.at < 5 * 60_000) continue;
        void withAssistantLock(`profile:${key}`, async () => {
          if (
            touched.get(key) !== use ||
            [...live.values()].some(
              (s) => ownerKey(s.row) === use.owner && isAssistantActive(s.state),
            )
          )
            return;
          const old = profiles.get(key);
          profiles.delete(key);
          touched.delete(key);
          await (await old?.catch(() => null))?.close();
        }).catch((error) => reportCaughtError(error, "api/assistant/idle-profile"));
      }
    }, 60_000);
    idleProfiles.unref();
  }
  const flowKey = (ctx: RequestContext, provider: AssistantProvider) =>
    digest([ownerKey(ctx), "agent", provider]);
  async function saveFlow(
    ctx: RequestContext,
    provider: AssistantProvider,
    flow: { state: AuthState; method: AuthMethod },
  ) {
    const { connection } = await enabled(ctx);
    await repos.assistant.saveAuthorization({
      id: flowKey(ctx, provider),
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      kind: `agent:${provider}`,
      payload: encrypt(JSON.stringify({ ...flow, clientId: connection.clientId })),
      expiresAt: new Date(Date.now() + 20 * 60_000),
    });
  }
  async function enabled(ctx: RequestContext) {
    return assistantCredential(ctx);
  }
  async function client(ctx: RequestContext) {
    const { connection } = await enabled(ctx);
    const key = JSON.stringify([assistantProfileKey(connection), connection.origin]);
    return withAssistantLock(`profile:${key}`, async () => {
      watchProfiles();
      touched.set(key, { at: Date.now(), owner: ownerKey(ctx) });
      let pending = profiles.get(key);
      if (!pending) {
        pending = factory(connection).catch(() => {
          profiles.delete(key);
          touched.delete(key);
          throw assistantError(
            "Could not connect to Mindwire on the assistant host. Check that the selected host is running and reachable, then retry.",
            503,
          );
        });
        profiles.set(key, pending);
      }
      const native = await pending;
      if (!native.healthy()) {
        profiles.delete(key);
        touched.delete(key);
        await native.close();
        throw assistantError("The agent stopped. Check its host connection and try again.", 503);
      }
      return native;
    });
  }
  async function owned(ctx: RequestContext, id: string) {
    const row = await repos.assistant.find(ctx, id);
    if (!row) throw assistantError("Conversation not found.", 404, "ASSISTANT_NOT_FOUND");
    return row;
  }
  function emit(state: LiveRun, event: Omit<AssistantEvent, "sequence">) {
    const item = { ...event, sequence: ++state.sequence };
    state.events.push(item);
    const size = Buffer.byteLength(JSON.stringify(item));
    state.sizes.push(size);
    state.bytes += size;
    // Bound replay, not the native transcript or run. A lagging reader reloads a snapshot.
    while (
      state.events.length > 1 &&
      (state.events.length > 2000 || state.bytes > 8 * 1024 * 1024)
    ) {
      state.events.shift();
      state.bytes -= state.sizes.shift()!;
    }
    state.messages = appendAssistantEvents(state.messages, [item], state.id);
    for (const listener of state.listeners) listener();
  }
  function activity(state: LiveRun, after = 0, runId?: string): AssistantActivity {
    return {
      runId: state.id,
      state: state.state,
      cursor: state.sequence,
      events: state.events.filter((e) => e.sequence > after),
      reset:
        (!!runId && state.id !== runId) ||
        after > state.sequence ||
        after < (state.events[0]?.sequence ?? 1) - 1,
      ...(state.error ? { error: state.error } : {}),
    };
  }
  function evictLater(state: LiveRun) {
    const timer = setTimeout(() => {
      if (live.get(state.row.id) === state) live.delete(state.row.id);
    }, 60_000);
    timer.unref();
  }
  async function history(
    ctx: RequestContext,
    row: AssistantRow,
    before?: string,
  ): Promise<MessagePage> {
    if (!row.requestId) return { messages: [], hasMore: false };
    try {
      const native = await client(ctx);
      const page = await assistantImageHistory(
        native.mindwire,
        row.nativeChatId,
        await native.mindwire.messagePage(row.nativeChatId, {
          agent: HARNESS[row.provider as AssistantProvider].agent,
          limit: 40,
          maxBytes: 512000,
          before,
        }),
      );
      await assistantCredential(ctx, row);
      return {
        ...page,
        messages: await presentMessages(ctx, row, page.messages),
      };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        return { messages: [], hasMore: false };
      throw assistantError("Could not load this conversation. Please try again.", 503);
    }
  }
  async function presentMessages(ctx: RequestContext, row: AssistantRow, messages: Message[]) {
    const ids = messages
      .flatMap((m) => m.parts ?? [])
      .flatMap((p) => (p.interaction?.id ? [assistantQuestionRequestId(p.interaction.id)] : []));
    const answered = await repos.assistant.answered(ctx, row.id, ids);
    return assistantMessages(messages, row.id).map((message) => ({
      ...message,
      parts: message.parts?.map((part) =>
        part.interaction?.id && answered.has(assistantQuestionRequestId(part.interaction.id))
          ? { ...part, interaction: { ...part.interaction, needsResponse: false } }
          : part,
      ),
    }));
  }
  async function reconcile(ctx: RequestContext, row: AssistantRow) {
    if (!isAssistantActive(row.state as AssistantRunState) || live.has(row.id)) return row;
    if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now()) return row;
    // A host restart loses its per-turn bridge. Never replay a prompt with a new bridge.
    return withAssistantLock(`reconcile:${row.id}`, async () => {
      let current = await owned(ctx, row.id);
      if (!isAssistantActive(current.state as AssistantRunState) || live.has(row.id))
        return current;
      if (!current.requestId) return current;
      const recovered = await repos.assistant.recover(ctx, row.id, current.requestId, workerId);
      if (!recovered) return owned(ctx, row.id);
      current = recovered;
      await assistantCredential(ctx, current);
      const mw = (await client(ctx)).mindwire;
      let status: AssistantRunState = "error";
      try {
        const run = current.runId
          ? await mw.run(current.runId)
          : await mw.latestRun(current.nativeChatId);
        if (run) {
          if (run.chatId !== current.nativeChatId)
            throw assistantError("Could not restore this conversation.", 503);
          if (complete(run.status)) status = run.status as AssistantRunState;
          else {
            await run.cancel();
            status = "cancelled";
          }
        }
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404)
          throw assistantError(
            "Could not confirm the previous turn's status. Try again before starting another turn.",
            503,
          );
      }
      if (current.requestId)
        await repos.assistant.progress(ctx, row.id, current.requestId, { state: status });
      await releaseTaskAccess(ctx, current);
      return { ...current, state: status, executionToken: null, executionTokenId: null };
    });
  }
  async function stopLive(state: LiveRun) {
    state.controller.abort();
    if (state.run && !complete(state.state)) await state.run.cancel();
  }
  /** Caller holds the turn lock so a concurrent start cannot outlive stop/delete. */
  async function stopConversation(ctx: RequestContext, id: string) {
    const row = await owned(ctx, id),
      state = live.get(id);
    if (state) {
      await stopLive(state);
      await state.finished;
      return row;
    }
    await repos.assistant.requestStop(ctx, id);
    return reconcile(ctx, row);
  }
  function watch(ctx: RequestContext, state: LiveRun) {
    let checking = false;
    const watchdog = setInterval(() => {
      if (checking || state.controller.signal.aborted) return;
      checking = true;
      Promise.all([
        assistantExecutionCredential(ctx, state.row, !state.token),
        repos.assistant.heartbeat(ctx, state.row.id, state.requestId, workerId),
      ])
        .then(async ([credential, row]) => {
          if (!row || row.stopRequested || (state.token && credential.token !== state.token))
            await stopLive(state);
        })
        .catch(async () => {
          state.error =
            "Assistant access changed. Start a new conversation after reviewing your permissions.";
          await stopLive(state);
        })
        .catch(() => state.controller.abort())
        .finally(() => {
          checking = false;
        });
    }, 3000);
    watchdog.unref();
    state.watchdog = watchdog;
  }
  async function consume(ctx: RequestContext, state: LiveRun, closeBridge: () => void) {
    try {
      for await (const event of state.run!.stream({ signal: state.controller.signal })) {
        if (event.interaction?.needsResponse && !isQuestion(event.interaction)) {
          // No native approval UI: tools are authorized exclusively by the MCP connection.
          // Stop unknown approval kinds too, rather than guessing a provider's "deny" action.
          state.error =
            "The agent requested access outside its OpenShip connection. This turn was stopped.";
          await stopLive(state);
          break;
        }
        const sanitized = assistantEvent(event);
        if (sanitized) emit(state, { native: sanitized });
      }
      const final = await state.run!.refresh();
      state.state = state.controller.signal.aborted
        ? "cancelled"
        : complete(final.status)
          ? (final.status as AssistantRunState)
          : "error";
      if (state.state === "error") state.error = assistantFailure(final.error);
    } catch {
      state.state = state.controller.signal.aborted ? "cancelled" : "error";
      if (state.state === "error") state.error = assistantFailure();
      await state.run?.cancel().catch(() => {});
    } finally {
      clearInterval(state.watchdog);
      closeBridge();
      try {
        await repos.assistant.progress(ctx, state.row.id, state.requestId, { state: state.state });
        await releaseTaskAccess(ctx, state.row);
      } catch (error) {
        reportCaughtError(error, "api/assistant/settle");
      }
      emit(state, { state: state.state, error: state.error });
      evictLater(state);
    }
  }
  async function provider(
    ctx: RequestContext,
    id: AssistantProvider,
  ): Promise<AssistantProviderInfo> {
    const native = await client(ctx),
      probe = await native.probe(id);
    const base = {
      id,
      name: HARNESS[id].name,
      installedVersion: probe.version,
      available: probe.available,
      issue: probe.issue,
      authStatus: { configured: false },
      authMethods: [],
      models: [],
      fields: [],
      settings: {},
    };
    if (!probe.available) return base;
    try {
      const mw = native.mindwire.withAgent(HARNESS[id].agent);
      const info = await mw.agent();
      const fields = info.schema.sections
        .flatMap((s) => s.fields)
        .filter((f) => f.type !== "secret" && SAFE_SETTINGS.has(f.canon ?? f.key));
      const config = await mw.getConfig();
      const customProviders =
        id === "codex" && info.capabilities?.customProviders
          ? Object.values((await mw.providers.list()).user ?? {})
              .filter((p) => p.id.startsWith("openship-") && p.baseUrl)
              .map((p) => ({
                id: p.id,
                name: p.name || p.id,
                baseUrl: p.baseUrl,
                models: p.models ?? [],
                hasKey: !!p.hasKey,
              }))
          : [];
      return {
        ...base,
        authStatus: info.authStatus,
        imageInput: info.capabilities?.imageInput === true,
        customProviders,
        customApiAvailable:
          id === "codex" &&
          !!info.capabilities &&
          "customProviderModels" in info.capabilities &&
          info.capabilities.customProviderModels === true,
        authMethods: info.authMethods,
        fields,
        models: info.authStatus.configured || customProviders.length ? await mw.models() : [],
        settings: Object.fromEntries(
          fields.map((f) => [f.key, String(config[f.key] ?? f.default ?? "")]),
        ),
      };
    } catch {
      throw assistantError(
        "Could not read your agent connection. Check Mindwire and try again.",
        503,
      );
    }
  }
  const service = {
    native: client,
    conversationView: publicConversation,
    async status(ctx: RequestContext) {
      if (!assistantAvailable())
        return { available: false, enabled: false, clientId: null, target: null, targets: [] };
      requireAssistantSession(ctx);
      const targets = await assistantTargets(ctx);
      const connection = await repos.assistant.connection(ctx);
      const base = { available: true, enabled: false, clientId: null, targets, target: null };
      if (!connection) return base;
      try {
        await assistantCredential(ctx);
        return {
          ...base,
          enabled: true,
          clientId: connection.clientId,
          target: connection.serverId
            ? (targets.find((t) => t.id === connection.serverId) ?? null)
            : localAssistantTarget(),
        };
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 403) return base;
        throw error;
      }
    },
    async disable(ctx: RequestContext) {
      await disableAssistantAccess(ctx);
      await repos.assistantAutomations.pause(ctx, true);
      for (const run of await repos.assistantAutomations.cancelPending(ctx)) {
        if (run.tokenId) await repos.personalAccessToken.revoke(run.tokenId, ctx.userId);
        await repos.assistantAutomations.update(ctx, run.id, { token: null });
      }
      await Promise.all(
        [...live.values()]
          .filter((s) => ownerKey(s.row) === ownerKey(ctx))
          .map(async (s) => {
            await stopLive(s);
            await s.finished;
          }),
      );
      return { ok: true };
    },
    provider,
    async providers(ctx: RequestContext) {
      return Promise.all(PROVIDERS.map((id) => provider(ctx, id)));
    },
    async authBegin(ctx: RequestContext, id: AssistantProvider, methodId: string) {
      return withAssistantLock(`auth:${ownerKey(ctx)}:${id}`, async () => {
        const info = await provider(ctx, id),
          method = info.authMethods.find((m) => m.id === methodId);
        if (!method)
          throw assistantError("Choose one of this agent's available sign-in methods.", 400);
        const state = await (
          await client(ctx)
        ).mindwire.auth.begin(methodId, { agent: HARNESS[id].agent });
        await saveFlow(ctx, id, { state, method });
        return state;
      });
    },
    async authStep(ctx: RequestContext, id: AssistantProvider, fields: Record<string, string>) {
      return withAssistantLock(`auth:${ownerKey(ctx)}:${id}`, async () => {
        const { connection } = await enabled(ctx);
        const saved = await repos.assistant.authorization(flowKey(ctx, id));
        const flow = saved
          ? (JSON.parse(decrypt(saved.payload)) as {
              state: AuthState;
              method: AuthMethod;
              clientId: string;
            })
          : null;
        if (!flow || flow.clientId !== connection.clientId)
          throw assistantError("This sign-in expired. Choose a sign-in method again.");
        const declared = [
          ...new Map(
            [...(flow.method.fields ?? []), ...(flow.state.fields ?? [])].map((f) => [f.key, f]),
          ).values(),
        ];
        const allowed = new Set(declared.map((f) => f.key));
        if (flow.state.flowId) {
          allowed.add("_flowId");
          allowed.add("_action");
        }
        if (
          Object.keys(fields).some((k) => !allowed.has(k)) ||
          (flow.state.flowId && fields._flowId !== flow.state.flowId) ||
          (fields._action && fields._action !== "cancel")
        )
          throw assistantError("Invalid sign-in fields.", 400);
        const state = await (
          await client(ctx)
        ).mindwire.auth.step(flow.state.flowId ? fields : assistantFieldInput(declared, fields), {
          agent: HARNESS[id].agent,
        });
        await saveFlow(ctx, id, { ...flow, state });
        return state;
      });
    },
    async logout(ctx: RequestContext, id: AssistantProvider) {
      if (
        (await repos.assistant.list(ctx)).some(
          (s) => s.provider === id && isAssistantActive(s.state as AssistantRunState),
        )
      )
        throw assistantError("Stop this agent's running conversations before disconnecting it.");
      await (await client(ctx)).mindwire.auth.logout({ agent: HARNESS[id].agent });
      await repos.assistant.authorization(flowKey(ctx, id), true);
      return { ok: true };
    },
    async configure(ctx: RequestContext, id: AssistantProvider, settings: Record<string, string>) {
      const info = await provider(ctx, id);
      for (const [key, value] of Object.entries(settings)) {
        const field = info.fields.find((f) => f.key === key);
        if (
          !field ||
          (value && field.options?.length && !field.options.some((o) => o.value === value))
        )
          throw assistantError("Invalid agent setting.", 400);
      }
      await (await client(ctx)).mindwire.setConfig(settings, { agent: HARNESS[id].agent });
      return { ok: true };
    },
    async customApi(
      ctx: RequestContext,
      input: { name: string; baseUrl: string; apiKey: string; model: string },
    ) {
      requireAssistantSession(ctx);
      await enabled(ctx);
      const info = await provider(ctx, "codex");
      if (!info.customApiAvailable)
        throw assistantError("Update the assistant runtime to add custom API connections.", 409);
      let url: URL;
      try {
        url = new URL(input.baseUrl);
      } catch {
        throw assistantError("Enter a valid API base URL.", 400);
      }
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      )
        throw assistantError(
          "Use an HTTPS endpoint, or HTTP on the assistant host’s localhost. Keep credentials in the API key field.",
          400,
        );
      if (!input.name.trim() || !input.apiKey.trim())
        throw assistantError("Enter a connection name and API key.", 400);
      const id = `openship-${randomUUID()}`;
      // Mindwire's PRIVATE per-user profile owns configuration and secrets. No native
      // login/logout, global settings change, or provider request from the Cloud API.
      const native = await client(ctx);
      await native.mindwire.withAgent(HARNESS.codex.agent).providers.set(
        id,
        {
          name: input.name.trim(),
          baseUrl: url.href.replace(/\/$/, ""),
          models: [input.model],
        },
        { apiKey: input.apiKey },
      );
      return { model: `${id}/${input.model}` };
    },
    async list(ctx: RequestContext) {
      await enabled(ctx);
      return Promise.all(
        (await repos.assistant.list(ctx)).map(async (row) => publicConversation(row)),
      );
    },
    async create(
      ctx: RequestContext,
      input: { provider: AssistantProvider; model?: string; agentId?: string },
      source?: ConversationSource,
    ) {
      const access = await enabled(ctx);
      const automationRunId =
        source && "automationRunId" in source ? source.automationRunId : undefined;
      const chat = source && "chatThreadId" in source ? source : undefined;
      const id = source && "id" in source ? (source.id ?? randomUUID()) : randomUUID();
      const specialist = input.agentId ? await ownedAgent(ctx, input.agentId) : null;
      if (specialist) {
        await validateAgentGrants(ctx, specialist);
        input = {
          ...input,
          provider: specialist.provider as AssistantProvider,
          model: specialist.model,
        };
      }
      if (chat) await validateChatConversation(ctx, { id, chatThreadId: chat.chatThreadId });
      const automation = automationRunId
        ? await repos.assistantAutomations.run(ctx, automationRunId)
        : null;
      if (automationRunId && !automation) throw assistantError("Automation run not found.", 404);
      const nativeChatId = randomUUID();
      if (specialist) {
        const bots = await nativeAgents(await client(ctx));
        const bot = await bots.get(specialist.id);
        if (bot.revision !== specialist.nativeRevision)
          throw assistantError(
            "This agent changed on its host. Save its settings before starting a task.",
            409,
          );
        await bots.chat(specialist.id, nativeChatId, automation?.definition.name ?? "New task");
      }
      return publicConversation(
        await repos.assistant.create({
          id,
          userId: ctx.userId,
          organizationId: ctx.organizationId,
          nativeChatId,
          agentId: specialist?.id ?? null,
          agentRevision: specialist?.revision ?? null,
          authority: specialist || automation ? await captureExecutionAuthority(ctx) : null,
          serverId: access.connection.serverId,
          clientId: access.connection.clientId,
          accessFingerprint: access.fingerprint,
          provider: input.provider,
          model: input.model ?? "",
          title: automation?.definition.name ?? "New conversation",
          automationRunId: automationRunId ?? null,
          chatThreadId: chat?.chatThreadId ?? null,
        }),
      );
    },
    async get(ctx: RequestContext, id: string): Promise<AssistantSnapshot> {
      await enabled(ctx);
      let row = await owned(ctx, id);
      try {
        await assistantCredential(ctx, row);
      } catch (error) {
        if ((error as { code?: string }).code !== "ASSISTANT_ACCESS_CHANGED") throw error;
        return {
          conversation: publicConversation(row),
          messages: [],
          activity: quiet(row),
          accessChanged: true,
          hasMore: false,
        };
      }
      row = await reconcile(ctx, row);
      const state = live.get(id);
      const page = state ? { messages: state.messages, ...state.history } : await history(ctx, row);
      return {
        conversation: publicConversation({ ...row, state: state?.state ?? row.state }),
        messages: page.messages,
        activity: state ? { ...activity(state, state.sequence), events: [] } : quiet(row),
        accessChanged: false,
        hasMore: page.hasMore,
        before: page.before,
      };
    },
    async history(ctx: RequestContext, id: string, before: string) {
      const row = await owned(ctx, id);
      await assistantCredential(ctx, row);
      return history(ctx, row, before);
    },
    /** Internal delivery reads exactly the requested native turn, never the latest chat history.
     * The shared native snapshot survives process restarts; OpenShip stores no transcript copy. */
    async turnSnapshot(
      ctx: RequestContext,
      id: string,
      requestId: string,
    ): Promise<AssistantSnapshot> {
      let row = await owned(ctx, id);
      await assistantExecutionCredential(ctx, row);
      row = await reconcile(ctx, row);
      const receipt = await repos.assistant.request(ctx, id, requestId);
      let activity = quiet({
        ...row,
        state: receipt?.state ?? "running",
        runId: receipt?.runId ?? null,
      });
      let messages: Message[] = [];
      if (receipt?.runId) {
        const run = await (await client(ctx)).mindwire.run(receipt.runId);
        const snapshot = await run.snapshot();
        if (snapshot.run.id !== receipt.runId || snapshot.run.chatId !== row.nativeChatId)
          throw assistantError("Could not restore this turn.", 503);
        activity = { ...activity, state: snapshot.run.status as AssistantRunState };
        messages = await presentMessages(ctx, row, [
          {
            id: `live-${receipt.runId}`,
            chatId: row.nativeChatId,
            role: "assistant",
            text: "",
            parts: snapshot.parts,
            createdAt: snapshot.run.createdAt,
          },
        ]);
      }
      await assistantExecutionCredential(ctx, row);
      return {
        conversation: publicConversation(row),
        messages,
        activity,
        hasMore: false,
        accessChanged: false,
      };
    },
    async start(
      ctx: RequestContext,
      id: string,
      input: AssistantTurnInput,
      source?: { automationRunId: string },
    ): Promise<AssistantActivity> {
      return withAssistantLock(`turn:${id}`, async () => {
        let row = await owned(ctx, id);
        const automationRunId =
          source && "automationRunId" in source ? source.automationRunId : undefined;
        if (
          automationRunId &&
          (row.automationRunId !== automationRunId || input.requestId !== automationRunId)
        )
          throw assistantError("Automation task does not match this conversation.", 403);
        await assistantCredential(ctx, row);
        if (row.agentId)
          await validateAgentGrants(
            ctx,
            await ownedAgent(ctx, row.agentId, row.agentRevision ?? undefined),
          );
        const attachments = input.attachments ?? [];
        const imageError = assistantImagesError(attachments);
        if (imageError) throw assistantError(imageError, 400);
        if (!input.message.trim() && !attachments.length)
          throw assistantError("Write a message or attach an image.", 400);
        // Bind retries to every input, including an explicitly selected model.
        const messageHash = digest([input.message, input.model ?? null, attachments]);
        row = await reconcile(ctx, row);
        const receipt = await repos.assistant.request(ctx, id, input.requestId);
        if (receipt) {
          if (receipt.messageHash !== messageHash)
            throw assistantError(
              "This request ID was already used for another message.",
              409,
              "ASSISTANT_REQUEST_CONFLICT",
            );
          const state = live.get(id);
          return state?.requestId === input.requestId
            ? activity(state)
            : { ...quiet({ ...row, state: receipt.state, runId: receipt.runId }), reset: true };
        }
        if (isAssistantActive(row.state as AssistantRunState))
          throw assistantError(
            "This conversation already has a running turn.",
            409,
            "ASSISTANT_BUSY",
          );
        const native = await client(ctx),
          info = await provider(ctx, row.provider as AssistantProvider);
        if (row.agentId && input.model !== undefined && input.model !== row.model)
          throw assistantError("Edit the agent to change its model, then start a new task.", 409);
        const model = input.model ?? row.model;
        if (
          input.model &&
          input.model !== row.model &&
          !info.models.some((item) => item.id === model)
        )
          throw assistantError("Choose a model available to this agent connection.", 400);
        if (attachments.length && !info.imageInput)
          throw assistantError("This agent does not support image input.", 400);
        row = { ...row, model };
        const custom = info.customProviders?.find((p) => row.model.startsWith(`${p.id}/`));
        if (
          row.model.startsWith("openship-") &&
          (!info.customApiAvailable ||
            !custom ||
            !custom.models.includes(row.model.slice(custom.id.length + 1)))
        )
          throw assistantError(
            "This custom model is no longer available. Choose its connection again.",
            409,
          );
        if (!info.available || !(custom ? custom.hasKey : info.authStatus.configured))
          throw assistantError(
            "Connect this agent in AI connections before sending a message.",
            409,
            "ASSISTANT_SIGN_IN",
          );
        if ((row.agentId || row.automationRunId) && !automationRunId)
          row = await prepareTaskAccess(ctx, row);
        await assistantExecutionCredential(ctx, row);
        const page = await history(ctx, row);
        if (
          !(await repos.assistant.claim(
            ctx,
            id,
            input.requestId,
            messageHash,
            input.message.trim() || "Image conversation",
            workerId,
            model,
          ))
        )
          throw assistantError(
            "This conversation already has a running turn.",
            409,
            "ASSISTANT_BUSY",
          );
        const state: LiveRun = {
          row,
          requestId: input.requestId,
          id: input.requestId,
          state: "running",
          controller: new AbortController(),
          events: [],
          sizes: [],
          bytes: 0,
          sequence: 0,
          messages: page.messages,
          history: { hasMore: page.hasMore, before: page.before },
          listeners: new Set(),
        };
        live.set(id, state);
        watch(ctx, state);
        let bridge: Awaited<ReturnType<typeof createAssistantBridge>> | undefined;
        try {
          const access = await assistantExecutionCredential(ctx, row);
          if (access.connection.serverId) {
            state.token = access.token;
            bridge = {
              url: `${access.connection.origin}/api/mcp`,
              token: access.token,
              close() {},
            };
          } else
            bridge = await createAssistantBridge({
              signal: state.controller.signal,
              forward: async (body) => {
                const credential = await assistantExecutionCredential(ctx, row);
                state.controller.signal.throwIfAborted();
                return app.fetch(
                  new Request(`${new URL(credential.connection.origin).origin}/api/mcp`, {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      authorization: `Bearer ${credential.token}`,
                      "user-agent": "OpenShip Assistant (Mindwire)",
                      "x-organization-id": row.organizationId,
                    },
                    body,
                  }),
                );
              },
            });
          let cwd = await native.workspace(row.nativeChatId);
          if (row.agentId) {
            const specialist = await ownedAgent(ctx, row.agentId, row.agentRevision ?? undefined);
            const bot = await (await nativeAgents(native)).get(specialist.id);
            if (bot.revision !== specialist.nativeRevision)
              throw assistantError("This agent changed on its host. Review its settings.", 409);
            cwd = await native.workspace(`openship-agent-${specialist.id}`);
          }
          const uploaded = [];
          for (const image of attachments) {
            await assistantExecutionCredential(ctx, row);
            uploaded.push(
              await native.mindwire.uploadAttachment(
                row.nativeChatId,
                {
                  name: image.name,
                  mime: image.mime,
                  data: Buffer.from(image.data, "base64"),
                },
                { signal: state.controller.signal },
              ),
            );
          }
          await assistantExecutionCredential(ctx, row);
          state.controller.signal.throwIfAborted();
          const run = await native.mindwire.turn({
            agent: HARNESS[row.provider as AssistantProvider].agent,
            chatId: row.nativeChatId,
            requestId: digest([row.nativeChatId, input.requestId]),
            message: input.message,
            cwd,
            options: {
              ...scopedTurnOptions(
                row.provider as AssistantProvider,
                bridge,
                row.model,
                !!row.chatThreadId,
                appLocale(await repos.settings.getLocale(ctx.userId)),
              ),
              ...(uploaded.length ? { attachments: uploaded } : {}),
            },
          });
          state.run = run;
          state.id = run.id;
          state.controller.signal.throwIfAborted();
          await repos.assistant.progress(ctx, id, input.requestId, { runId: run.id });
          emit(state, {
            user: {
              id: `user-${input.requestId}`,
              chatId: id,
              role: "user",
              text: input.message,
              ...(attachments.length ? { attachments } : {}),
              createdAt: new Date().toISOString(),
            },
            state: "running",
          });
          state.finished = consume(ctx, state, bridge.close);
          return activity(state);
        } catch {
          clearInterval(state.watchdog);
          bridge?.close();
          await state.run?.cancel().catch(() => {});
          state.state = state.controller.signal.aborted ? "cancelled" : "error";
          state.error = state.state === "error" ? assistantFailure() : undefined;
          await repos.assistant.progress(ctx, id, input.requestId, { state: state.state });
          await releaseTaskAccess(ctx, state.row);
          emit(state, { state: state.state, error: state.error });
          evictLater(state);
          return activity(state);
        }
      });
    },
    /** Follow-up input is delivered to the current native turn, never a competing task. */
    async message(ctx: RequestContext, id: string, input: { requestId: string; message: string }) {
      if (!input.message.trim()) throw assistantError("Write a message first.", 400);
      const key = `input:${input.requestId}`;
      const hash = digest([input.message]);
      const result = await withAssistantLock(`turn:${id}`, async () => {
        const current = await owned(ctx, id);
        await assistantCredential(ctx, current);
        const existing = await repos.assistant.request(ctx, id, key);
        if (existing && existing.messageHash !== hash)
          throw assistantError("This message ID was already used.", 409);
        const snapshot = () =>
          live.has(id) ? activity(live.get(id)!) : { ...quiet(current), reset: true };
        if (existing?.state === "done") return snapshot();
        if (existing?.runId && existing.runId !== current.runId)
          throw assistantError(
            "This message belongs to an earlier turn. Inspect the conversation before retrying.",
            409,
          );
        if (!isAssistantActive(current.state as AssistantRunState) || !current.runId) {
          if (existing)
            throw assistantError(
              "The turn finished before this message was acknowledged. Inspect the conversation before sending a new message.",
              409,
            );
          return null;
        }
        await assistantExecutionCredential(ctx, current);
        const claimed = await repos.assistant.claimAnswer(ctx, id, key, hash);
        if (!claimed || claimed.messageHash !== hash)
          throw assistantError("This message ID was already used.", 409);
        await repos.assistant.finishAnswer(ctx, id, key, { runId: current.runId });
        const run = await (await client(ctx)).mindwire.run(current.runId);
        if (run.chatId !== current.nativeChatId) throw assistantError("Task not found.", 404);
        await run.sendInput(input.message, { requestId: digest([id, key]) });
        await repos.assistant.finishAnswer(ctx, id, key, { runId: current.runId, state: "done" });
        const state = live.get(id);
        if (state)
          emit(state, {
            user: {
              id: key,
              chatId: id,
              role: "user",
              text: input.message,
              createdAt: new Date().toISOString(),
            },
          });
        return snapshot();
      });
      // start owns the same turn lock and the normal durable request ledger.
      return result ?? service.start(ctx, id, input);
    },
    async activity(
      ctx: RequestContext,
      id: string,
      input: { after?: number; runId?: string; waitMs?: number },
      signal?: AbortSignal,
    ) {
      const row = await owned(ctx, id);
      await assistantCredential(ctx, row);
      const state = live.get(id);
      if (!state) {
        // A different replica reads the durable native transcript. Pace snapshot polling;
        // do not spin on cursor zero or steal a healthy worker's event stream.
        if (input.waitMs && isAssistantActive(row.state as AssistantRunState))
          await delay(Math.min(input.waitMs, 1500), undefined, { signal });
        await assistantCredential(ctx, row);
        const current = await reconcile(ctx, await owned(ctx, id));
        return {
          ...quiet(current),
          reset: Boolean(input.runId) || isAssistantActive(current.state as AssistantRunState),
        };
      }
      if (input.waitMs && isAssistantActive(state.state) && state.sequence <= (input.after ?? 0)) {
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            state.listeners.delete(done);
            signal?.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            done();
            reject(signal?.reason);
          };
          const timer = setTimeout(done, input.waitMs);
          state.listeners.add(done);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      await assistantCredential(ctx, row);
      return activity(state, input.after, input.runId);
    },
    async stop(ctx: RequestContext, id: string, expectedRunId?: string | null) {
      return withAssistantLock(`turn:${id}`, async () => {
        // Delivery deadlines must never cancel a newer turn started in the dashboard.
        if (expectedRunId !== undefined && (await owned(ctx, id)).runId !== expectedRunId)
          return { ok: true };
        await stopConversation(ctx, id);
        return { ok: true };
      });
    },
    async remove(ctx: RequestContext, id: string) {
      return withAssistantLock(`turn:${id}`, async () => {
        const row = await stopConversation(ctx, id);
        const { connection } = await enabled(ctx);
        if (row.serverId !== connection.serverId)
          throw assistantError(
            "Choose this conversation's original assistant host before deleting its history.",
            409,
            "ASSISTANT_ACCESS_CHANGED",
          );
        if (!live.has(id) && isAssistantActive(row.state as AssistantRunState))
          throw assistantError(
            "Stopping this conversation. Retry deleting it once the turn has stopped.",
            409,
            "ASSISTANT_BUSY",
          );
        if (row.requestId) await (await client(ctx)).mindwire.deleteChat(row.nativeChatId);
        await repos.assistant.remove(ctx, id);
        live.delete(id);
        return { ok: true };
      });
    },
    async respond(
      ctx: RequestContext,
      id: string,
      input: { interactionId: string; requestId: string; answers: Record<string, QuestionAnswer> },
    ) {
      const row = await owned(ctx, id);
      if (row.automationRunId)
        throw assistantError(
          "Review this investigation in Automations. Automated conversations cannot accept replies.",
          403,
          "ASSISTANT_AUTOMATION",
        );
      return withAssistantLock(`question:${id}`, async () => {
        await assistantExecutionCredential(ctx, row);
        const receiptId = assistantQuestionRequestId(input.interactionId);
        const answerHash = digest(
          Object.entries(input.answers)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, answer]) => [
              key,
              [...(answer.options ?? [])].sort(),
              answer.text?.trim() ?? "",
            ]),
        );
        const existing = await repos.assistant.request(ctx, id, receiptId);
        if (existing && existing.messageHash !== answerHash)
          throw assistantError(
            "An answer has already been submitted for this question. Review the conversation before sending another message.",
            409,
            "ASSISTANT_REQUEST_CONFLICT",
          );
        if (existing?.state === "done") return { ok: true };
        const state = live.get(id);
        const messages = state?.messages ?? (await history(ctx, row)).messages;
        const interaction = messages
          .flatMap((m) => m.parts ?? [])
          .map((p) => p.interaction)
          .reverse()
          .find((i) => i?.id === input.interactionId);
        if (!interaction || !isQuestion(interaction) || !interaction.needsResponse)
          throw assistantError("This question is no longer waiting for an answer.");
        const text = answerText(interaction, input.answers);
        const receipt =
          existing ?? (await repos.assistant.claimAnswer(ctx, id, receiptId, answerHash));
        if (!receipt) throw assistantError("Conversation not found.", 404);
        if (receipt.messageHash !== answerHash)
          throw assistantError("This question already has an answer in progress.", 409);
        if (interaction.responseMode === "message") {
          const run = receipt.runId
            ? state?.run?.id === receipt.runId
              ? state.run
              : await (await client(ctx)).mindwire.run(receipt.runId)
            : state?.run && isAssistantActive(state.state)
              ? state.run
              : row.runId && isAssistantActive(row.state as AssistantRunState)
                ? await (await client(ctx)).mindwire.run(row.runId)
                : undefined;
          let delivered = false;
          if (run) {
            await repos.assistant.finishAnswer(ctx, id, receiptId, { runId: run.id });
            try {
              await run.sendInput(text, { requestId: digest([row.nativeChatId, receiptId]) });
              delivered = true;
            } catch (error) {
              // Only a definite closed ingress can start a fresh, permission-checked turn.
              // Ambiguous delivery retries reuse the same native run and idempotency key.
              if (
                !(error instanceof ApiError) ||
                error.status !== 409 ||
                (await run.refresh()).status !== "done"
              )
                throw error;
              await state?.finished;
            }
          }
          if (!delivered) {
            const result = await service.start(ctx, id, {
              requestId: digest([receiptId, "turn"]),
              message: text,
            });
            if (result.state === "error" || result.state === "cancelled")
              throw assistantError(
                "The answer could not start a new turn. Review the conversation and send a new message.",
                409,
              );
            if (result.runId)
              await repos.assistant.finishAnswer(ctx, id, receiptId, { runId: result.runId });
          }
        } else {
          const run =
            state?.run ?? (row.runId ? await (await client(ctx)).mindwire.run(row.runId) : null);
          if (!run || complete((await run.refresh()).status))
            throw assistantError("This question's turn has ended.");
          await repos.assistant.finishAnswer(ctx, id, receiptId, { runId: run.id });
          await run.respond({ interactionId: input.interactionId, answers: input.answers });
        }
        await repos.assistant.finishAnswer(ctx, id, receiptId, { state: "done" });
        const current = live.get(id);
        if (current)
          emit(current, {
            native: {
              type: "interaction",
              interaction: {
                ...interaction,
                needsResponse: false,
                response: { interactionId: interaction.id, answers: input.answers },
              },
            },
          });
        return { ok: true };
      });
    },
    async close() {
      clearInterval(idleProfiles);
      idleProfiles = undefined;
      await Promise.all(
        [...live.values()].map(async (state) => {
          await stopLive(state).catch(() => {});
          await state.finished;
        }),
      );
      await Promise.all(
        [...profiles.values()].map(async (p) => (await p.catch(() => null))?.close()),
      );
      profiles.clear();
      touched.clear();
      live.clear();
    },
  };
  return service;
}
function answerText(interaction: Interaction, answers: Record<string, QuestionAnswer>) {
  const questions = interaction.questions ?? [];
  if (Object.keys(answers).some((id) => !questions.some((q) => q.id === id)))
    throw assistantError("Unknown question.", 400);
  const message = questions
    .map((q) => {
      const answer = answers[q.id] ?? {},
        selected = answer.options ?? [];
      if (q.options?.length && q.allowOther === false && answer.text?.trim())
        throw assistantError("Choose one of the offered answers.", 400);
      if (
        (!q.multiSelect && selected.length > 1) ||
        selected.some((id) => !q.options?.some((o) => o.id === id))
      )
        throw assistantError("Choose one of the offered answers.", 400);
      const value = [
        ...selected.map((id) => q.options!.find((o) => o.id === id)!.label),
        answer.text?.trim(),
      ]
        .filter(Boolean)
        .join("; ");
      if (!value && !q.optional) throw assistantError("Answer the required questions first.", 400);
      return `${q.title}\n${value}`;
    })
    .join("\n\n");
  if (!message.trim() || message.length > 32000) throw assistantError("Invalid answer.", 400);
  return message;
}
export const assistant = createAssistantRuntime();
