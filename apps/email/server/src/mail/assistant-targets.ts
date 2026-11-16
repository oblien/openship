import { Mindwire, remote } from "mindwire";
import { z } from "zod";
import { env } from "../env";
import { managedAssistant } from "./assistant-containers";
import { assistantConnection } from "./assistant-connection-store";

const targetSchema = z.object({
  url: z.url(),
  token: z.string().min(20),
  agent: z.enum(["codex", "claude-code"]),
  directory: z.string().min(1),
  model: z.string().max(200).optional(),
});
export type AssistantTarget = z.infer<typeof targetSchema> & { managedOwner?: string };

function secureUrl(value: string) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(env.NODE_ENV !== "production" && local && url.protocol === "http:"))
  ) {
    throw new Error("Use HTTPS for mail assistant connections.");
  }
  return url.href.replace(/\/$/, "");
}

/** Operator-owned bindings. Browser input and mail content cannot choose a URL, token or host path. */
export function assistantTarget(owner: string): (AssistantTarget & { mcpUrl: string }) | null {
  const bindings = z
    .record(z.string().regex(/^[a-f0-9]{64}$/), targetSchema)
    .parse(JSON.parse(env.MAIL_MINDWIRE_TARGETS));
  const endpoints = new Set<string>();
  for (const target of Object.values(bindings)) {
    const endpoint = secureUrl(target.url);
    if (endpoints.has(endpoint))
      throw new Error("Each mailbox requires its own isolated Mindwire daemon.");
    endpoints.add(endpoint);
  }
  const target = bindings[owner];
  if ((!target && !env.MAIL_MINDWIRE_DOCKER_SOCKET) || !env.MAIL_PUBLIC_URL) return null;
  const connection = assistantConnection(owner);
  // Internal MCP routing is operator-owned, never provided by the browser or the model.
  const mcpUrl = env.MAIL_MINDWIRE_MCP_URL ?? `${secureUrl(env.MAIL_PUBLIC_URL)}/mcp`;
  return {
    ...(target
      ? { ...target, url: secureUrl(target.url) }
      : { managedOwner: owner, url: "", token: "", directory: "/root", agent: "codex" as const }),
    ...(connection ? { agent: connection.agent, model: connection.model ?? undefined } : {}),
    mcpUrl,
  };
}

export const assistantRuntime = {
  connect(target: AssistantTarget) {
    if (target.managedOwner) return managedAssistant(target.managedOwner).withAgent(target.agent);
    return new Mindwire({
      agent: target.agent,
      target: remote(target.url, { token: target.token }),
      requestTimeoutMs: 20_000,
      fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
    });
  },
};
