import type { AppLocale } from "@repo/core";
import { chatCopy, formatChat } from "./chat-copy";
import { chatLocale } from "./chat-locale";
import { randomUUID } from "node:crypto";
import { repos, type ChatAppConnection, type ChatAppReceipt, type ChatAppThread } from "@repo/db";
import {
  isAssistantActive,
  pendingAssistantQuestions,
  type AssistantProvider,
  type AssistantSnapshot,
} from "@repo/contracts";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { createProvisionLock } from "@repo/platform/engine/lib/provision-lock";
import { resolveDashboardPublicUrl } from "@repo/platform/engine/lib/public-url";
import {
  assistant,
  assistantQuestionRequestId,
  type createAssistantRuntime,
} from "../assistant/assistant.service";
import { chatCredential } from "./chat-apps-access";
import { chatAssistantAccess, validateChatConversation } from "./chat-assistant-access";
import { chatInput, chatLabel, type ChatAssistantHandler } from "./chat-apps-commands";
import { fail, fingerprint, senderKey } from "./chat-apps-common";
import type { HostEvent } from "./transport/types";

const conversationUrl = (id: string) =>
  `${resolveDashboardPublicUrl()}/assistant?chat=${encodeURIComponent(id)}`;
const questions = (snapshot: AssistantSnapshot) =>
  pendingAssistantQuestions(
    snapshot.messages,
    snapshot.activity.runId,
    isAssistantActive(snapshot.activity.state),
  );

/** Only visible answer text leaves the runtime. Thinking, raw tool output and credentials do not. */
export function chatAssistantReply(
  snapshot: AssistantSnapshot,
  locale: AppLocale = "en",
): string | null {
  const copy = chatCopy(locale);
  const url = conversationUrl(snapshot.conversation.id);
  if (snapshot.accessChanged) return `${copy.permissions}\n${url}`;
  const pending = questions(snapshot);
  if (pending.length) {
    const prompt = pending
      .flatMap(({ interaction }) => interaction.questions ?? [])
      .map((q) => [q.title, ...(q.options ?? []).map((o) => `• ${o.label}`)].join("\n"))
      .join("\n\n");
    return `${prompt.slice(0, 2400)}\n\n${pending.length === 1 && pending[0]!.interaction.questions?.length === 1 ? copy.assistant.answerHere : copy.assistant.answerInApp}\n${url}`;
  }
  if (isAssistantActive(snapshot.activity.state)) return null;
  if (snapshot.activity.state !== "done") return `${copy.assistant.stoppedOrFailed}\n${url}`;
  let boundary = snapshot.messages.length - 1;
  while (boundary >= 0 && snapshot.messages[boundary]!.role !== "user") boundary--;
  const text = snapshot.messages
    .slice(boundary + 1)
    .filter((m) => m.role === "assistant")
    .map((m) =>
      m.parts?.length
        ? m.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n")
        : m.text,
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return `${text ? text.slice(0, 2400) + (text.length > 2400 ? "…" : "") : copy.assistant.finished}\n\n${copy.assistant.openConversation}: ${url}`;
}

/** A transport adapter around the existing runtime, not a second agent/deployment pipeline. */
export function createChatAssistant(
  runtime: ReturnType<typeof createAssistantRuntime> = assistant,
): ChatAssistantHandler {
  async function context(c: ChatAppConnection, event: HostEvent) {
    const { identity } = await chatCredential(c, event);
    const { ctx } = await chatAssistantAccess(c, identity);
    return { identity, ctx };
  }
  async function validate(c: ChatAppConnection, event: HostEvent, receipt: ChatAppReceipt) {
    const { identity, ctx } = await context(c, event);
    if (receipt.identityId !== identity.id)
      throw fail("This chat account changed. Link it again.", 403);
    if (receipt.conversationId) {
      const row = await repos.assistant.find(ctx, receipt.conversationId);
      if (!row) throw fail("This conversation is no longer available.", 403);
      const { thread } = await validateChatConversation(ctx, row);
      if (thread.identityId !== identity.id || thread.senderKey !== senderKey(event))
        throw fail("This conversation belongs to another chat.", 403);
    }
    return ctx;
  }
  async function result(c: ChatAppConnection, event: HostEvent, receipt: ChatAppReceipt) {
    const ctx = await validate(c, event, receipt);
    const locale = await chatLocale(c, event);
    const copy = chatCopy(locale);
    if (!receipt.conversationId) return copy.assistant.interrupted;
    const snapshot = await runtime.turnSnapshot(
      ctx,
      receipt.conversationId,
      receipt.assistantRequestId ?? receipt.id,
    );
    // A stopped/restarted process must not leave a private agent running indefinitely.
    if (
      isAssistantActive(snapshot.activity.state) &&
      Date.now() - receipt.createdAt.getTime() > 10 * 60_000
    ) {
      await runtime.stop(ctx, receipt.conversationId, snapshot.activity.runId);
      return `${copy.assistant.timeLimit}\n${conversationUrl(receipt.conversationId)}`;
    }
    const reply = chatAssistantReply(snapshot, locale);
    await validate(c, event, receipt);
    return reply;
  }
  return {
    validate: async (c, event, receipt) => {
      await validate(c, event, receipt);
    },
    result,
    async execute(c, event, receiptId) {
      const { identity, ctx } = await context(c, event);
      const copy = chatCopy(await chatLocale(c, event));
      const input = chatInput(event);
      if (input.verb === "ask" && (!input.arg || input.arg.length > 32000))
        throw fail("Send a message between 1 and 32,000 characters.", 400);
      const key = fingerprint([identity.id, senderKey(event)]);
      return createProvisionLock(`chat-assistant-thread:${key}`).run(async () => {
        const route = senderKey(event);
        let thread: ChatAppThread | undefined = await repos.chatApps.activeThread(
          identity.id,
          route,
        );
        if (
          thread &&
          (thread.identityRevision !== identity.assistantRevision ||
            thread.connectionRevision !== c.revision)
        )
          thread = undefined;
        // A process can stop between reserving a thread and creating its conversation.
        // Deleted history also clears on the next message; neither case replays an old turn.
        if (thread && !(await repos.assistant.find(ctx, thread.conversationId))) {
          await repos.chatApps.removeThread(thread.id);
          thread = undefined;
        }
        if (input.verb === "chats" || input.verb === "resume") {
          const bindings = (await repos.chatApps.threads(identity.id, route)).filter(
            (t) =>
              t.identityRevision === identity.assistantRevision &&
              t.connectionRevision === c.revision,
          );
          const conversations = (await repos.assistant.list(ctx)).filter((row) =>
            bindings.some((t) => t.conversationId === row.id && row.chatThreadId === t.id),
          );
          if (input.verb === "chats")
            return conversations.length
              ? `${copy.assistant.recent}\n${conversations
                  .slice(0, 8)
                  .map(
                    (row) =>
                      `${thread?.conversationId === row.id ? `${copy.assistant.current} · ` : ""}${chatLabel(row.title)}\n/openship resume ${row.id}`,
                  )
                  .join("\n\n")}\n\n${copy.assistant.history}`
              : copy.assistant.empty;
          const chosen = conversations.find((row) => row.id === input.arg);
          if (!chosen)
            throw fail(
              "Conversation not found here. Use /openship chats to choose one of your conversations.",
              404,
            );
          await validateChatConversation(ctx, chosen);
          if (
            thread &&
            thread.conversationId !== chosen.id &&
            isAssistantActive((await runtime.get(ctx, thread.conversationId)).activity.state)
          )
            return copy.assistant.active;
          await repos.chatApps.selectThread(bindings.find((t) => t.conversationId === chosen.id)!);
          return `${formatChat(copy.assistant.resuming, { name: chatLabel(chosen.title) })}\n${conversationUrl(chosen.id)}`;
        }
        if (input.verb === "chat")
          return thread
            ? `${copy.assistant.openConversation}\n${conversationUrl(thread.conversationId)}`
            : copy.assistant.empty;
        if (input.verb === "stop" || input.verb === "new") {
          if (thread) {
            await runtime.stop(ctx, thread.conversationId);
            if (input.verb === "new") await repos.chatApps.deactivateThread(thread.id);
          }
          return input.verb === "new" ? copy.assistant.new : copy.assistant.stopped;
        }
        let snapshot: AssistantSnapshot | undefined;
        if (thread) {
          snapshot = await runtime.get(ctx, thread.conversationId);
          if (snapshot.accessChanged)
            throw fail("Assistant access changed. Reconnect it in Settings → Chat apps.", 403);
        }
        if (!thread) {
          thread = await repos.chatApps.saveThread({
            id: randomUUID(),
            identityId: identity.id,
            senderKey: senderKey(event),
            connectionRevision: c.revision,
            identityRevision: identity.assistantRevision,
            conversationId: randomUUID(),
          });
          await runtime.create(
            ctx,
            {
              provider: identity.assistantProvider as AssistantProvider,
              model: identity.assistantModel,
            },
            { chatThreadId: thread.id, id: thread.conversationId },
          );
        }
        const pending = snapshot && questions(snapshot);
        const question =
          pending?.length === 1 && pending[0]!.interaction.questions?.length === 1
            ? pending[0]!.interaction.questions[0]!
            : undefined;
        if (pending?.length && !question)
          return `${copy.assistant.answerInApp}\n${conversationUrl(thread.conversationId)}`;
        if (snapshot && isAssistantActive(snapshot.activity.state) && !question)
          return `${copy.assistant.active}\n${conversationUrl(thread.conversationId)}`;
        const option = question?.options?.find(
          (o) => o.label.toLowerCase() === input.arg!.toLowerCase() || o.id === input.arg,
        );
        if (question && !option && question.allowOther === false)
          return `${copy.assistant.choose}\n${conversationUrl(thread.conversationId)}`;
        // The durable receipt precedes native execution. A replay only observes this conversation.
        await repos.chatApps.bindConversation(
          receiptId,
          thread.conversationId,
          question && pending?.[0]
            ? assistantQuestionRequestId(pending[0].interaction.id)
            : receiptId,
          encrypt(JSON.stringify(event)),
        );
        const currentIdentity = await repos.chatApps.identityById(identity.id);
        if (!currentIdentity) throw fail("This chat account was disconnected. Link it again.", 403);
        await chatAssistantAccess(c, currentIdentity);
        if (question && pending?.[0]) {
          await runtime.respond(ctx, thread.conversationId, {
            requestId: receiptId,
            interactionId: pending[0].interaction.id,
            answers: { [question.id]: option ? { options: [option.id] } : { text: input.arg! } },
          });
        } else {
          await runtime.start(ctx, thread.conversationId, {
            requestId: receiptId,
            message: input.arg!,
          });
        }
        return null;
      });
    },
  };
}
