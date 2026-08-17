import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  NonceCache,
  signEnvelope,
  verifyEnvelope,
  type AgentEnvelope,
} from "./protocol";
import type { AgentConfig } from "./config";
import { OperationJournal } from "./journal";
import { executeOp } from "./ops";

export type AgentRuntime = {
  config: AgentConfig;
  journal: OperationJournal;
  nonces: NonceCache;
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleSignedOp(runtime: AgentRuntime, raw: unknown): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const verified = verifyEnvelope(raw, {
    secretForKid: (kid) => (kid === runtime.config.keyId ? runtime.config.sharedSecret : undefined),
    nonces: runtime.nonces,
  });
  if (!verified.ok) {
    return { status: 401, body: { ok: false, error: verified.reason } };
  }

  const { envelope } = verified;
  const opId =
    envelope.payload && typeof envelope.payload === "object" && "opId" in envelope.payload
      ? String((envelope.payload as { opId?: unknown }).opId)
      : envelope.nonce;

  if (runtime.journal.isDone(opId)) {
    const prev = runtime.journal.readAll().get(opId);
    return { status: 200, body: { ok: true, replayed: true, result: prev?.result ?? null } };
  }

  const entry = runtime.journal.begin(envelope.op, envelope.payload, opId);
  try {
    const result = await executeOp(envelope.op, envelope.payload, runtime.journal);
    runtime.journal.finish(entry.id, result);
    const reply = signEnvelope({
      kid: runtime.config.keyId,
      secret: runtime.config.sharedSecret,
      op: "ping",
      payload: { result, opId: entry.id, requestOp: envelope.op },
    });
    return { status: 200, body: { ok: true, result, reply } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.journal.fail(entry.id, message);
    return { status: 500, body: { ok: false, error: message } };
  }
}

export function startAgentHttp(runtime: AgentRuntime): Server {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/healthz" || url === "/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, serverId: runtime.config.serverId }));
      return;
    }
    if (req.method !== "POST" || (url !== "/op" && url !== "/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    try {
      const rawText = await readBody(req);
      const raw = rawText ? (JSON.parse(rawText) as AgentEnvelope) : null;
      const out = await handleSignedOp(runtime, raw);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });
  server.listen(runtime.config.listenPort, runtime.config.listenHost);
  return server;
}
