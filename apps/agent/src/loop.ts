import { collectReport } from "./report";
import { executeOp } from "./ops";
import { signEnvelope, verifyEnvelope, type AgentEnvelope } from "./protocol";
import { incompleteEntries } from "./journal";
import type { AgentRuntime } from "./server";
import { handleSignedOp } from "./server";

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function replayIncomplete(runtime: AgentRuntime): Promise<number> {
  const incomplete = incompleteEntries(runtime.journal.readAll());
  let replayed = 0;
  for (const entry of incomplete) {
    if (runtime.journal.isDone(entry.id)) continue;
    try {
      const result = await executeOp(entry.op, entry.payload, runtime.journal);
      runtime.journal.finish(entry.id, result);
      replayed += 1;
    } catch (err) {
      runtime.journal.fail(entry.id, err instanceof Error ? err.message : String(err));
    }
  }
  return replayed;
}

export async function heartbeatOnce(runtime: AgentRuntime): Promise<void> {
  const report = await collectReport();
  const envelope = signEnvelope({
    kid: runtime.config.keyId,
    secret: runtime.config.sharedSecret,
    op: "report",
    payload: report,
  });
  const url = `${runtime.config.controlPlaneUrl}/api/servers/${runtime.config.serverId}/agent/report`;
  let response: unknown;
  try {
    response = await postJson(url, envelope);
  } catch {
    return;
  }
  const ops =
    response && typeof response === "object" && Array.isArray((response as { ops?: unknown }).ops)
      ? ((response as { ops: unknown[] }).ops as AgentEnvelope[])
      : [];
  for (const raw of ops) {
    const verified = verifyEnvelope(raw, {
      secretForKid: (kid) => (kid === runtime.config.keyId ? runtime.config.sharedSecret : undefined),
      nonces: runtime.nonces,
    });
    if (!verified.ok) continue;
    await handleSignedOp(runtime, raw);
  }
}

export function startHeartbeat(runtime: AgentRuntime): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    await heartbeatOnce(runtime).catch(() => undefined);
    if (!stopped) timer = setTimeout(tick, runtime.config.heartbeatSeconds * 1000);
  };
  let timer: ReturnType<typeof setTimeout> = setTimeout(tick, runtime.config.heartbeatSeconds * 1000);
  void tick();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
