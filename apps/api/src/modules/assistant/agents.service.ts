import { reportCaughtError } from "@repo/core/diagnostics";
import { isDeepStrictEqual } from "node:util";
import { repos, type AssistantAgentRow } from "@repo/db";
import type {
  AssistantAgent,
  AssistantAgentConfig,
  AssistantAgentIcon,
  AssistantProvider,
} from "@repo/contracts";
import { captureExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import { nativeAgents } from "@repo/platform/engine/modules/assistant/native-agents";
import type { RequestContext } from "../../lib/request-context";
import { assistant, type createAssistantRuntime } from "./assistant.service";
import {
  assistantCredential,
  assistantError,
  digest,
  isAssistantUserSession,
  ownerKey,
  withAssistantLock,
} from "./assistant-access";
import { ownedAgent, validateAgentGrants } from "./agent-access";

export function createAssistantAgents(
  runtime: ReturnType<typeof createAssistantRuntime> = assistant,
) {
  async function native(ctx: RequestContext) {
    return nativeAgents(await runtime.native(ctx));
  }
  async function stopPreviousWork(ctx: RequestContext, id: string) {
    const { createAssistantAutomations } = await import("./automation.service");
    await createAssistantAutomations({ runtime }).invalidateAgent(ctx, id);
    for (const chat of await repos.assistantAgents.tasks(ctx, id)) {
      if (["running", "waiting"].includes(chat.state))
        await runtime
          .stop(ctx, chat.id)
          .catch((error) => reportCaughtError(error, "api/assistant/agent-stop"));
    }
  }
  async function view(ctx: RequestContext, row: AssistantAgentRow): Promise<AssistantAgent> {
    await validateAgentGrants(ctx, row);
    const bot = await (await native(ctx)).get(row.id);
    return {
      id: row.id,
      revision: row.revision,
      name: bot.name,
      icon: row.icon as AssistantAgentIcon,
      purpose: bot.purpose,
      instructions: bot.instructions,
      provider: row.provider as AssistantProvider,
      model: row.model,
      readOnly: row.readOnly,
      grants: row.grants,
      archived: row.archived,
      createdAt: row.createdAt.toISOString(),
      tasks: (await repos.assistantAgents.tasks(ctx, row.id))
        // An edited agent may have narrower grants than its historical tasks.
        // Bearers cannot use those new grants to recover older private context.
        .filter((chat) => isAssistantUserSession(ctx) || chat.agentRevision === row.revision)
        .map(runtime.conversationView),
    };
  }
  const service = {
    async list(ctx: RequestContext) {
      const access = await assistantCredential(ctx);
      const rows = (await repos.assistantAgents.list(ctx)).filter(
        (r) =>
          r.clientId === access.connection.clientId && r.serverId === access.connection.serverId,
      );
      const visible: AssistantAgent[] = [];
      for (const row of rows) {
        try {
          visible.push(await view(ctx, row));
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 403) throw error;
        }
      }
      return visible;
    },
    async get(ctx: RequestContext, id: string) {
      const row = await repos.assistantAgents.find(ctx, id);
      if (!row) throw assistantError("Agent not found.", 404);
      const access = await assistantCredential(ctx);
      if (
        row.clientId !== access.connection.clientId ||
        row.serverId !== access.connection.serverId
      )
        throw assistantError("Agent not found on this host.", 404);
      return view(ctx, row);
    },
    async save(
      ctx: RequestContext,
      input: AssistantAgentConfig,
      intent: { requestId: string } | { id: string; revision: number },
    ) {
      const access = await validateAgentGrants(ctx, input);
      const id =
        "id" in intent
          ? intent.id
          : digest([ownerKey(ctx), access.connection.clientId, "agent", intent.requestId]);
      return withAssistantLock(`agent:${id}`, async () => {
        const previous = await repos.assistantAgents.find(ctx, id);
        if ("id" in intent && (!previous || previous.archived))
          throw assistantError("Agent not found.", 404);
        if (previous && "id" in intent && previous.revision !== intent.revision)
          throw assistantError("This agent changed. Reload before saving.", 409);
        if (
          previous &&
          (previous.clientId !== access.connection.clientId ||
            previous.serverId !== access.connection.serverId)
        )
          throw assistantError("Agent not found on this host.", 404);
        if (previous && previous.provider !== input.provider)
          throw assistantError("Create a new agent to use a different connection.", 400);
        if (previous) await validateAgentGrants(ctx, previous);
        const api = await native(ctx);
        const identity = {
          name: input.name.trim(),
          purpose: input.purpose.trim(),
          instructions: input.instructions.trim(),
        };
        if (!identity.name || !identity.purpose)
          throw assistantError("Name this agent and describe its task.", 400);
        const current = previous ? await view(ctx, previous) : null;
        if (previous && "requestId" in intent) {
          if (
            !isDeepStrictEqual(
              [
                current!.name,
                current!.icon,
                current!.purpose,
                current!.instructions,
                current!.model,
                current!.readOnly,
                current!.grants,
              ],
              [
                identity.name,
                input.icon ?? "bot",
                identity.purpose,
                identity.instructions,
                input.model,
                input.readOnly,
                input.grants,
              ],
            )
          )
            throw assistantError("This request ID already created a different agent.", 409);
          return current!;
        }
        if (
          previous &&
          current &&
          isDeepStrictEqual(
            [
              current.name,
              current.purpose,
              current.instructions,
              current.model,
              current.readOnly,
              current.grants,
            ],
            [
              identity.name,
              identity.purpose,
              identity.instructions,
              input.model,
              input.readOnly,
              input.grants,
            ],
          )
        ) {
          const saved = await repos.assistantAgents.setIcon(
            ctx,
            id,
            previous.revision,
            input.icon ?? previous.icon,
          );
          if (!saved) throw assistantError("This agent changed. Reload before saving.", 409);
          return { ...current, icon: saved.icon as AssistantAgentIcon };
        }
        if (
          !previous &&
          (await repos.assistantAgents.list(ctx)).filter((r) => !r.archived).length >= 30
        )
          throw assistantError("Archive an unused agent before creating another.", 400);
        const info = await runtime.provider(ctx, input.provider);
        if (input.model && !info.models.some((m) => m.id === input.model))
          throw assistantError("Choose an available model for this agent.", 400);
        const bot = previous
          ? await api.update(id, (await api.get(id)).revision, identity)
          : await api.create(id, input.provider, identity);
        const policy = {
          model: input.model,
          icon: input.icon ?? previous?.icon ?? "bot",
          readOnly: input.readOnly,
          grants: input.grants,
          nativeRevision: bot.revision,
          authority: await captureExecutionAuthority(ctx),
        };
        const saved = previous
          ? await repos.assistantAgents.update(ctx, id, previous.revision, policy)
          : await repos.assistantAgents.create({
              id,
              userId: ctx.userId,
              organizationId: ctx.organizationId,
              clientId: access.connection.clientId,
              serverId: access.connection.serverId,
              provider: input.provider,
              ...policy,
            });
        if (!saved) throw assistantError("This agent changed. Reload before saving.", 409);
        if (previous) await stopPreviousWork(ctx, id);
        return view(ctx, saved);
      });
    },
    async archive(ctx: RequestContext, id: string, revision: number) {
      return withAssistantLock(`agent:${id}`, async () => {
        const row = await repos.assistantAgents.find(ctx, id);
        if (!row) throw assistantError("Agent not found.", 404);
        const access = await validateAgentGrants(ctx, row);
        if (
          row.clientId !== access.connection.clientId ||
          row.serverId !== access.connection.serverId
        )
          throw assistantError("Agent not found on this host.", 404);
        if (!row.archived && row.revision !== revision)
          throw assistantError("This agent changed. Refresh before archiving.", 409);
        const saved = row.archived
          ? row
          : await repos.assistantAgents.update(ctx, id, revision, { archived: true });
        if (!saved) throw assistantError("This agent changed. Refresh before archiving.", 409);
        await stopPreviousWork(ctx, id);
        // The policy is disabled before touching the host, so a host outage cannot keep it running.
        try {
          const api = await native(ctx);
          const bot = await api.get(id);
          if (!bot.archived) await api.update(id, bot.revision, { archived: true });
          return { archived: true, hostSynced: true };
        } catch (error) {
          reportCaughtError(error, "api/assistant/archive-host");
          return { archived: true, hostSynced: false };
        }
      });
    },
    async task(ctx: RequestContext, id: string, input: { requestId: string; message: string }) {
      const agent = await ownedAgent(ctx, id);
      await validateAgentGrants(ctx, agent);
      const conversationId = digest([ownerKey(ctx), id, "task", input.requestId]);
      return withAssistantLock(`task:${conversationId}`, async () => {
        let row = await repos.assistant.find(ctx, conversationId);
        if (!row) {
          await runtime.create(
            ctx,
            { provider: agent.provider as AssistantProvider, model: agent.model, agentId: id },
            { id: conversationId },
          );
          row = await repos.assistant.find(ctx, conversationId);
        }
        if (!row || row.agentId !== id) throw assistantError("Task not found.", 404);
        const activity = await runtime.start(ctx, row.id, input);
        return {
          conversation: runtime.conversationView(row),
          activity,
          path: `/assistant?chat=${row.id}`,
        };
      });
    },
    async inspect(ctx: RequestContext, id: string, chatId: string) {
      const row = await repos.assistant.find(ctx, chatId);
      if (!row || row.agentId !== id) throw assistantError("Task not found.", 404);
      const agent = await service.get(ctx, id);
      if (row.agentRevision !== agent.revision && !isAssistantUserSession(ctx))
        throw assistantError(
          "Open this older task in the dashboard. Its agent's permissions have changed.",
          403,
        );
      return runtime.get(ctx, chatId);
    },
    async message(
      ctx: RequestContext,
      id: string,
      chatId: string,
      input: { requestId: string; message: string },
    ) {
      await service.inspect(ctx, id, chatId);
      await validateAgentGrants(ctx, await ownedAgent(ctx, id));
      return runtime.message(ctx, chatId, input);
    },
    async stop(ctx: RequestContext, id: string, chatId: string) {
      await service.inspect(ctx, id, chatId);
      return runtime.stop(ctx, chatId);
    },
  };
  return service;
}
export const assistantAgents = createAssistantAgents();
