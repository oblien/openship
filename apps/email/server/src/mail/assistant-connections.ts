import type { Mindwire } from "mindwire";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db, schema } from "../db";
import { mailboxId, type MailboxCredentials } from "./identity";
import { assistantTarget, assistantRuntime } from "./assistant-targets";
import { assistantConnection } from "./assistant-connection-store";
import { assistantState, configureAssistant } from "./assistant";
import { encryptSecret } from "../lib/crypto";
import { createRateLimiter } from "../lib/rate-limit";

export const aiProvider = z.enum(["openai", "anthropic", "custom"]);
type AiProvider = z.infer<typeof aiProvider>;
const agentFor = (provider: AiProvider) =>
  provider === "anthropic" ? ("claude-code" as const) : ("codex" as const);

export const connectAiInput = z.object({
  provider: aiProvider,
  apiKey: z.string().trim().min(1).max(8192),
  model: z.string().trim().max(200).default(""),
  baseUrl: z.string().max(2048).optional(),
  name: z.string().trim().max(80).optional(),
});
const connecting = new Set<string>();
const prepared = new Map<string, Mindwire>();
const attempts = createRateLimiter({ windowMs: 60_000, max: 5 });

function runtime(owner: string, agent: "codex" | "claude-code") {
  const target = assistantTarget(owner);
  if (!target)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "AI connections are not available on this mail server yet.",
    });
  return assistantRuntime.connect({ ...target, agent });
}

async function prepareRuntime(mw: Mindwire, start: boolean) {
  const health = await mw.health();
  if (!health.ok || (health.botsVersion ?? 0) < 9)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The mail assistant runtime needs an update.",
    });
  const info = await mw.agent();
  if (info.configured) return { ready: true, running: false };
  const status = start ? await mw.setup() : await mw.setupStatus();
  return { ready: status.ok, running: status.running };
}

export async function prepareAssistant(
  mailbox: MailboxCredentials,
  provider: AiProvider,
  start = false,
) {
  try {
    const owner = mailboxId(mailbox);
    const agent = agentFor(provider);
    const key = `${owner}:${agent}`;
    if (start) prepared.set(key, runtime(owner, agent));
    const client = prepared.get(key);
    if (!client) return { ready: false, running: false, provider };
    const status = await prepareRuntime(client, start);
    return { ...status, provider };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Could not prepare AI. Try again in a moment.",
    });
  }
}

function customBaseUrl(value?: string) {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid HTTPS API URL." });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Use an HTTPS API URL without credentials or query parameters.",
    });
  return url.href.replace(/\/$/, "");
}

export async function connectAssistant(
  mailbox: MailboxCredentials,
  input: z.infer<typeof connectAiInput>,
) {
  const owner = mailboxId(mailbox);
  if (connecting.has(owner) || assistantState(mailbox).busy)
    throw new TRPCError({
      code: "CONFLICT",
      message: "An assistant operation is still in progress.",
    });
  if (assistantConnection(owner) || assistantState(mailbox).enabled)
    throw new TRPCError({
      code: "CONFLICT",
      message: "Disconnect the current AI connection first.",
    });
  if (!attempts.hit(owner).ok)
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Wait a minute before trying again.",
    });
  const baseUrl = input.provider === "custom" ? customBaseUrl(input.baseUrl) : undefined;
  if (baseUrl && !input.model)
    throw new TRPCError({ code: "BAD_REQUEST", message: "Enter your provider’s model ID." });
  const agent = agentFor(input.provider);
  const mw = runtime(owner, agent);
  const customProvider = baseUrl ? "openship-mail" : null;
  const metadata: typeof schema.mailAssistantConnection.$inferInsert = {
    mailboxId: owner,
    agent,
    name:
      input.provider === "custom"
        ? input.name || "Custom API"
        : input.provider === "openai"
          ? "OpenAI"
          : "Anthropic",
    model: customProvider ? `${customProvider}/${input.model}` : input.model || null,
    customProvider,
  };
  connecting.add(owner);
  let credentialWritten = false;
  try {
    await configureAssistant(mailbox, true, false, {
      connect: async (assertActive) => {
        const status = await prepareRuntime(mw, false);
        if (!status.ready)
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Wait for AI setup to finish before connecting.",
          });
        assertActive();
        if (baseUrl) {
          const info = await mw.agent();
          if (!info.capabilities.customProviders)
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "This runtime needs an update to connect a custom API.",
            });
          credentialWritten = true;
          await mw.providers.set(
            customProvider!,
            {
              name: input.name || "Custom API",
              baseUrl,
              models: [input.model],
            },
            { apiKey: input.apiKey },
          );
        } else {
          // The published SDK owns the native credential format and auth flow.
          const methods = await mw.auth.methods();
          const method = methods.find((method) => method.id === "apiKey" && !method.interactive);
          if (!method)
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "API key connections are unavailable for this provider.",
            });
          await mw.auth.begin(method.id);
          credentialWritten = true;
          const result = await mw.auth.step({ apiKey: input.apiKey });
          if (result.status !== "complete")
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Could not connect with this API key. Check it and try again.",
            });
        }
        assertActive();
        db.insert(schema.mailAssistantConnection).values(metadata).run();
      },
      rollback: async () => {
        if (!credentialWritten) return;
        const removed = await (
          customProvider ? mw.providers.delete(customProvider) : mw.auth.logout()
        ).then(
          () => true,
          () => false,
        );
        if (removed) {
          db.delete(schema.mailAssistantConnection)
            .where(eq(schema.mailAssistantConnection.mailboxId, owner))
            .run();
        } else {
          // Retain a disconnected row so the user can retry removing a key after a network failure.
          db.insert(schema.mailAssistantConnection).values(metadata).onConflictDoNothing().run();
        }
      },
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    // Native provider errors can contain credential-bearing request details.
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Could not connect AI. Check your connection details and try again.",
    });
  } finally {
    connecting.delete(owner);
  }
}

export async function disconnectAssistant(mailbox: MailboxCredentials) {
  const owner = mailboxId(mailbox);
  // Revoke mail access immediately, even if the runtime is offline.
  await configureAssistant(mailbox, false);
  if (connecting.has(owner)) return { ok: true };
  const connection = assistantConnection(owner);
  if (!connection) return { ok: true };
  connecting.add(owner);
  try {
    const mw = runtime(owner, connection.agent);
    if (connection.customProvider) await mw.providers.delete(connection.customProvider);
    else await mw.auth.logout();
    db.delete(schema.mailAssistantConnection)
      .where(eq(schema.mailAssistantConnection.mailboxId, owner))
      .run();
    db.update(schema.mailAssistant)
      .set({ chatId: "", history: encryptSecret("[]", `mail-assistant:${owner}:history`) })
      .where(eq(schema.mailAssistant.mailboxId, owner))
      .run();
    return { ok: true };
  } catch {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Mail access is off. Try disconnecting again to remove the saved AI key.",
    });
  } finally {
    connecting.delete(owner);
  }
}
