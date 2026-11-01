import { AppError } from "@repo/core";
import type { AssistantNativeClient } from "./native-target";
import type { AssistantProvider } from "@repo/contracts";
import { HARNESS } from "./harness-policy";

/** Saved bots use the ordinary native turn API. The application remains the only tool authority. */
export async function nativeAgents(native: AssistantNativeClient) {
  const mw = native.mindwire;
  const health = await mw.health();
  if ((health.botsVersion ?? 0) < 9)
    throw new AppError(
      "Update Mindwire on the assistant host to use scoped agents (bot protocol 9 required).",
      409,
      "ASSISTANT_HOST_UPDATE",
    );
  return {
    async create(
      id: string,
      provider: AssistantProvider,
      input: { name: string; purpose: string; instructions: string },
    ) {
      const projectId = `openship-agent-${id}`;
      const cwd = await native.workspace(projectId);
      const snapshot = await mw.workspace.snapshot();
      if (!snapshot.projects.some((p) => p.id === projectId))
        await mw.workspace.projects.put(projectId, { name: "OpenShip agent", path: cwd });
      const { agentId } = await mw.workspace.ensureAgent({ agentType: HARNESS[provider].agent });
      const config = {
        id,
        agentId,
        projectId,
        ...input,
        externalTools: true,
        notificationsMuted: true,
      };
      return (await mw.bots.create(config)).bot;
    },
    async get(id: string) {
      const bot = await mw.bots.get(id);
      if (
        !(bot as typeof bot & { externalTools?: boolean }).externalTools ||
        bot.isMaster ||
        bot.raw
      )
        throw new AppError(
          "This native agent is not managed by OpenShip.",
          409,
          "ASSISTANT_AGENT_POLICY",
        );
      return bot;
    },
    async update(
      id: string,
      revision: number,
      input: { name?: string; purpose?: string; instructions?: string; archived?: boolean },
    ) {
      return (await mw.bots.update(id, { expectedRevision: revision, ...input })).bot;
    },
    async chat(id: string, chatId: string, title: string) {
      await mw.bots.createChat(id, { chatId, title });
    },
  };
}
