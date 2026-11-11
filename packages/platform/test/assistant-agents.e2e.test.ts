import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SDK_VERSION } from "mindwire";
import { createAssistantClient } from "../src/engine/modules/assistant/native-target";
import { nativeAgents } from "../src/engine/modules/assistant/native-agents";

// Uses the dependency's released daemon, including its real bot protocol and
// persistent registry. No model invocation or existing native sign-in is needed.
it.skipIf(process.env.OPENSHIP_ASSISTANT_E2E !== "1")(
  "creates, edits and reopens scoped agents with the released Mindwire daemon",
  async () => {
    const directory = await mkdtemp("/tmp/openship-agent-protocol-");
    let client: Awaited<ReturnType<typeof createAssistantClient>> | undefined;
    try {
      client = await createAssistantClient(directory, "fixture", "private", "chat-apps");
      const health = await client.mindwire.health();
      expect(health.version).toBe(SDK_VERSION);
      expect(health.botsVersion).toBeGreaterThanOrEqual(9);
      const methods = await client.mindwire.withAgent("codex").auth.methods();
      expect(methods.map((method) => method.id)).toContain("loginDevice");
      const agents = await nativeAgents(client);
      const saved = [];
      for (const provider of ["codex", "claude"] as const) {
        const id = randomUUID();
        const bot = await agents.create(id, provider, {
          name: `${provider} investigator`,
          purpose: "Investigate downtime",
          instructions: "Use only the tools and permissions supplied by OpenShip.",
        });
        expect(bot).toMatchObject({ id, externalTools: true, notificationsMuted: true });
        const edited = await agents.update(id, bot.revision, {
          instructions: "Report findings only.",
        });
        expect(edited.revision).toBeGreaterThan(bot.revision);
        const chatId = randomUUID();
        await agents.chat(id, chatId, "Downtime investigation");
        expect(await client.mindwire.bots.chats(id)).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: chatId, botId: id })]),
        );
        saved.push(id);
      }
      await client.close();
      client = await createAssistantClient(directory, "fixture", "private", "chat-apps");
      const reopened = await nativeAgents(client);
      for (const id of saved)
        expect(await reopened.get(id)).toMatchObject({
          id,
          externalTools: true,
          instructions: "Report findings only.",
        });
    } finally {
      await client?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
