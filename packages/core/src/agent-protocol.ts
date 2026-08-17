/**
 * HMAC-SHA256 signed envelopes between the control plane and a server agent.
 *
 * The agent does not plan: it executes ops the control plane already decided.
 * Both directions share one kid + secret. Signature is over canonical JSON of
 * `{ v, kid, ts, nonce, op, payload }` (no `sig` field).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const AGENT_PROTOCOL_VERSION = 1 as const;
export const AGENT_MAX_SKEW_MS = 5 * 60 * 1000;
export const AGENT_DEFAULT_PORT = 7422;
export const AGENT_DEFAULT_LISTEN = "127.0.0.1";

export const AGENT_OPS = [
  "ping",
  "report",
  "renew_certs",
  "run_backup",
  "health_check",
  "recover_releases",
  "execute_release",
] as const;

export type AgentOp = (typeof AGENT_OPS)[number];

export type AgentEnvelopeBody = {
  v: typeof AGENT_PROTOCOL_VERSION;
  kid: string;
  ts: number;
  nonce: string;
  op: AgentOp;
  payload: unknown;
};

export type AgentEnvelope = AgentEnvelopeBody & { sig: string };

export type VerifyFailure =
  | "bad_shape"
  | "bad_version"
  | "unknown_kid"
  | "unknown_op"
  | "stale"
  | "replay"
  | "bad_signature";

export type VerifyResult =
  | { ok: true; envelope: AgentEnvelope }
  | { ok: false; reason: VerifyFailure };

const SIGNED_KEYS = ["v", "kid", "ts", "nonce", "op", "payload"] as const;

/** Deterministic JSON: sorted object keys, no whitespace, undefined omitted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export function isAgentOp(value: unknown): value is AgentOp {
  return typeof value === "string" && (AGENT_OPS as readonly string[]).includes(value);
}

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function signEnvelope(input: {
  kid: string;
  secret: string;
  op: AgentOp;
  payload?: unknown;
  ts?: number;
  nonce?: string;
}): AgentEnvelope {
  const body: AgentEnvelopeBody = {
    v: AGENT_PROTOCOL_VERSION,
    kid: input.kid,
    ts: input.ts ?? Date.now(),
    nonce: input.nonce ?? randomBytes(16).toString("hex"),
    op: input.op,
    payload: input.payload ?? {},
  };
  const sig = hmacHex(input.secret, canonicalJson(pickSigned(body)));
  return { ...body, sig };
}

function pickSigned(envelope: AgentEnvelopeBody): AgentEnvelopeBody {
  return {
    v: envelope.v,
    kid: envelope.kid,
    ts: envelope.ts,
    nonce: envelope.nonce,
    op: envelope.op,
    payload: envelope.payload,
  };
}

function asEnvelope(raw: unknown): AgentEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.kid !== "string" || o.kid.length === 0) return null;
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return null;
  if (typeof o.nonce !== "string" || o.nonce.length === 0) return null;
  if (typeof o.sig !== "string" || o.sig.length === 0) return null;
  if (!isAgentOp(o.op)) return null;
  if (!SIGNED_KEYS.every((k) => k in o)) return null;
  return {
    v: o.v as AgentEnvelope["v"],
    kid: o.kid,
    ts: o.ts,
    nonce: o.nonce,
    op: o.op,
    payload: o.payload,
    sig: o.sig,
  };
}

export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = AGENT_MAX_SKEW_MS * 2) {}

  has(nonce: string): boolean {
    this.prune(Date.now());
    return this.seen.has(nonce);
  }

  add(nonce: string, now = Date.now()): void {
    this.seen.set(nonce, now);
  }

  prune(now = Date.now()): void {
    for (const [nonce, ts] of this.seen) {
      if (now - ts > this.ttlMs) this.seen.delete(nonce);
    }
  }
}

export function verifyEnvelope(
  raw: unknown,
  opts: {
    secretForKid: (kid: string) => string | undefined | null;
    nonces: NonceCache;
    now?: number;
    maxSkewMs?: number;
  },
): VerifyResult {
  const envelope = asEnvelope(raw);
  if (!envelope) return { ok: false, reason: "bad_shape" };
  if (envelope.v !== AGENT_PROTOCOL_VERSION) return { ok: false, reason: "bad_version" };
  if (!isAgentOp(envelope.op)) return { ok: false, reason: "unknown_op" };

  const now = opts.now ?? Date.now();
  const maxSkew = opts.maxSkewMs ?? AGENT_MAX_SKEW_MS;
  if (Math.abs(now - envelope.ts) > maxSkew) return { ok: false, reason: "stale" };
  if (opts.nonces.has(envelope.nonce)) return { ok: false, reason: "replay" };

  const secret = opts.secretForKid(envelope.kid);
  if (!secret) return { ok: false, reason: "unknown_kid" };

  const expected = hmacHex(secret, canonicalJson(pickSigned(envelope)));
  if (!safeEqualHex(expected, envelope.sig)) return { ok: false, reason: "bad_signature" };

  opts.nonces.add(envelope.nonce, now);
  return { ok: true, envelope };
}

export function mintAgentKeyId(): string {
  return `agk_${randomBytes(12).toString("hex")}`;
}

export function mintAgentSecret(): string {
  return randomBytes(32).toString("base64url");
}
