/**
 * Signed OpenShip server agent — enrollment and op dispatch.
 *
 * The control plane remains the planner. An enrolled agent is the always-on
 * executor on the box so certs / backups / health can continue when a desktop
 * control plane is closed. If no agent is enrolled, callers keep today's
 * API-process job path.
 */

import { repos, type Server, type ServerAgentPendingOp, type ServerAgentState } from "@repo/db";
import {
  AGENT_DEFAULT_PORT,
  AGENT_OPS,
  mintAgentKeyId,
  mintAgentSecret,
  signEnvelope,
  verifyEnvelope,
  NonceCache,
  type AgentEnvelope,
  type AgentOp,
} from "@repo/core/agent-protocol";
import { decryptSecretField, encryptSecretField } from "../../lib/credential-encryption";
import { env, runtimeTarget } from "../../config/env";

export const AGENT_LISTEN_PORT = AGENT_DEFAULT_PORT;

export type PublicAgentStatus = {
  enrolled: boolean;
  enrolledAt: string | null;
  keyId: string | null;
  lastSeenAt: string | null;
  capabilities: string[];
  version: string | null;
};

export type AgentDispatchResult = {
  ok: boolean;
  via: "http" | "ssh" | "queued" | "none";
  skipped?: boolean;
  result?: unknown;
  error?: string;
};

const incomingNonces = new NonceCache();

export function publicAgentStatus(server: Server | null | undefined): PublicAgentStatus {
  const agent = server?.agent ?? null;
  const enrolled = Boolean(agent?.keyId && server?.agentSecret);
  return {
    enrolled,
    enrolledAt: agent?.enrolledAt ?? null,
    keyId: enrolled ? agent!.keyId : null,
    lastSeenAt: agent?.lastSeenAt ?? null,
    capabilities: agent?.capabilities ?? [],
    version: agent?.version ?? null,
  };
}

export function stripPendingOps(agent: ServerAgentState | null | undefined): ServerAgentState | null {
  if (!agent) return null;
  const { pendingOps: _pending, ...rest } = agent;
  return rest;
}

export function agentInstallSnippet(opts: {
  serverId: string;
  keyId: string;
  secret: string;
  controlPlaneUrl: string;
  image?: string;
}): string {
  const config = JSON.stringify(
    {
      controlPlaneUrl: opts.controlPlaneUrl.replace(/\/+$/, ""),
      serverId: opts.serverId,
      keyId: opts.keyId,
      sharedSecret: opts.secret,
    },
    null,
    2,
  );
  const image = opts.image ?? "ghcr.io/oblien/openship-agent:latest";
  return [
    "install -d /etc/openship /var/lib/openship/agent",
    "cat > /etc/openship/agent.json <<'EOF'",
    config,
    "EOF",
    "docker rm -f openship-agent >/dev/null 2>&1 || true",
    `docker run -d --name openship-agent --restart unless-stopped --network host \\`,
    "  -v /etc/openship/agent.json:/etc/openship/agent.json:ro \\",
    "  -v /var/lib/openship/agent:/var/lib/openship/agent \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    `  ${image}`,
  ].join("\n");
}

export function resolveControlPlaneUrl(explicit?: string | null, requestOrigin?: string | null): string {
  const candidates = [
    explicit,
    env.OPENSHIP_ADVERTISED_ORIGIN,
    env.OPENSHIP_PUBLIC_URL,
    requestOrigin,
    runtimeTarget.api,
  ];
  for (const raw of candidates) {
    if (typeof raw === "string" && raw.trim()) return raw.trim().replace(/\/+$/, "");
  }
  return "http://127.0.0.1:4000";
}

function decryptAgentSecret(server: Server): string | undefined {
  return decryptSecretField(server.agentSecret);
}

export async function enrolledServerIds(): Promise<string[]> {
  const rows = await repos.server.listEnrolled();
  return rows.filter((s) => s.agent?.keyId && s.agentSecret).map((s) => s.id);
}

export function isEnrolled(server: Server | null | undefined): boolean {
  return Boolean(server?.agent?.keyId && server.agentSecret);
}

export async function enrollServerAgent(
  server: Server,
  opts: { controlPlaneUrl?: string | null; requestOrigin?: string | null },
): Promise<{
  keyId: string;
  secret: string;
  controlPlaneUrl: string;
  install: string;
  agent: PublicAgentStatus;
}> {
  const keyId = mintAgentKeyId();
  const secret = mintAgentSecret();
  const controlPlaneUrl = resolveControlPlaneUrl(opts.controlPlaneUrl, opts.requestOrigin);
  const agent: ServerAgentState = {
    enrolledAt: new Date().toISOString(),
    keyId,
    lastSeenAt: null,
    capabilities: [...AGENT_OPS],
    version: null,
    pendingOps: [],
  };
  await repos.server.update(server.id, {
    agent,
    agentSecret: encryptSecretField(secret),
  });
  return {
    keyId,
    secret,
    controlPlaneUrl,
    install: agentInstallSnippet({
      serverId: server.id,
      keyId,
      secret,
      controlPlaneUrl,
    }),
    agent: publicAgentStatus({ ...server, agent, agentSecret: "set" }),
  };
}

export async function revokeServerAgent(server: Server): Promise<void> {
  await repos.server.update(server.id, { agent: null, agentSecret: null });
}

export async function recordAgentReport(
  server: Server,
  envelope: AgentEnvelope,
): Promise<AgentEnvelope[]> {
  const prev = server.agent;
  if (!prev) return [];
  const payload = envelope.payload && typeof envelope.payload === "object" ? (envelope.payload as Record<string, unknown>) : {};
  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.map(String)
    : prev.capabilities;
  const version = typeof payload.version === "string" ? payload.version : prev.version;
  const pending = [...(prev.pendingOps ?? [])];
  const next: ServerAgentState = {
    ...prev,
    lastSeenAt: new Date().toISOString(),
    capabilities,
    version,
    pendingOps: [],
  };
  await repos.server.update(server.id, { agent: next });

  const secret = decryptAgentSecret(server);
  if (!secret) return [];
  return pending.map((op) =>
    signEnvelope({
      kid: prev.keyId,
      secret,
      op: op.op as AgentOp,
      payload: { ...(typeof op.payload === "object" && op.payload ? op.payload : {}), opId: op.id },
    }),
  );
}

export function verifyAgentEnvelope(server: Server, raw: unknown) {
  const secret = decryptAgentSecret(server);
  return verifyEnvelope(raw, {
    secretForKid: (kid) => (kid === server.agent?.keyId ? secret : undefined),
    nonces: incomingNonces,
  });
}

async function enqueuePending(server: Server, op: AgentOp, payload: unknown): Promise<AgentDispatchResult> {
  const prev = server.agent;
  if (!prev) return { ok: false, via: "none", error: "not_enrolled" };
  const pending: ServerAgentPendingOp = {
    id: `opq_${crypto.randomUUID()}`,
    op,
    payload,
    queuedAt: new Date().toISOString(),
  };
  await repos.server.update(server.id, {
    agent: { ...prev, pendingOps: [...(prev.pendingOps ?? []), pending] },
  });
  return { ok: true, via: "queued" };
}

function agentHttpUrl(server: Server): string | null {
  const envUrl = process.env.OPENSHIP_AGENT_URL?.trim();
  if (envUrl) return envUrl.replace(/\/+$/, "") + "/op";
  if (server.isLocal) return `http://127.0.0.1:${AGENT_LISTEN_PORT}/op`;
  return null;
}

async function postEnvelope(url: string, envelope: AgentEnvelope): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const err =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `agent HTTP ${res.status}`;
    throw new Error(err);
  }
  return parsed;
}

async function postEnvelopeViaSsh(server: Server, envelope: AgentEnvelope): Promise<unknown> {
  const { resolveServerExecutor } = await import("../../lib/deployment-runtime");
  const { execOnHost } = await import("../../lib/agent-exec");
  const resolved = await resolveServerExecutor(server.id, server.organizationId ?? undefined);
  const b64 = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  const cmd =
    `printf '%s' ${shellSingleQuote(b64)} | base64 -d | ` +
    `curl -sS -m 120 -X POST http://127.0.0.1:${AGENT_LISTEN_PORT}/op ` +
    `-H 'content-type: application/json' --data-binary @-`;
  const result = await execOnHost(resolved.executor, { command: cmd, timeoutMs: 130_000 });
  if (result.timedOut) throw new Error("agent SSH dispatch timed out");
  if (result.exitCode !== 0) {
    throw new Error(result.output.trim() || `agent SSH dispatch exit ${result.exitCode}`);
  }
  const text = result.output.trim();
  if (!text) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function dispatchOutcome(parsed: unknown): AgentDispatchResult {
  const body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const result = body.result && typeof body.result === "object" ? (body.result as Record<string, unknown>) : body;
  const skipped = result.skipped === true;
  const ok = body.ok !== false && result.ok !== false;
  return { ok, via: "http", skipped, result };
}

/**
 * Send a decided op to the enrolled agent. Returns null when the server has
 * no agent so callers can keep the in-process job path.
 */
export async function dispatchToAgent(
  serverId: string,
  op: AgentOp,
  payload: unknown = {},
): Promise<AgentDispatchResult | null> {
  const server = await repos.server.get(serverId);
  if (!server || !isEnrolled(server)) return null;
  const secret = decryptAgentSecret(server);
  if (!secret || !server.agent) return null;

  const envelope = signEnvelope({
    kid: server.agent.keyId,
    secret,
    op,
    payload,
  });

  const url = agentHttpUrl(server);
  if (url) {
    try {
      const parsed = await postEnvelope(url, envelope);
      return { ...dispatchOutcome(parsed), via: "http" };
    } catch (err) {
      // Local agent down — fall back to queue so a later heartbeat still runs it.
      const queued = await enqueuePending(server, op, payload);
      return { ...queued, error: err instanceof Error ? err.message : String(err) };
    }
  }

  try {
    const parsed = await postEnvelopeViaSsh(server, envelope);
    return { ...dispatchOutcome(parsed), via: "ssh" };
  } catch {
    return enqueuePending(server, op, payload);
  }
}
