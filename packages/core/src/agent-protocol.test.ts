import { describe, expect, it } from "vitest";
import {
  AGENT_MAX_SKEW_MS,
  AGENT_OPS,
  NonceCache,
  canonicalJson,
  signEnvelope,
  verifyEnvelope,
} from "./agent-protocol";

const KID = "agk_test";
const SECRET = "test-shared-secret-not-for-prod";

function verify(
  raw: unknown,
  opts?: { now?: number; secret?: string; nonces?: NonceCache },
) {
  return verifyEnvelope(raw, {
    secretForKid: (kid) => (kid === KID ? (opts?.secret ?? SECRET) : undefined),
    nonces: opts?.nonces ?? new NonceCache(),
    now: opts?.now,
  });
}

describe("canonicalJson", () => {
  it("sorts object keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: 2, z: undefined })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested objects so payload key order cannot change the sig", () => {
    expect(canonicalJson({ payload: { y: 1, x: 2 } })).toBe(
      '{"payload":{"x":2,"y":1}}',
    );
  });
});

describe("sign / verify", () => {
  it("accepts a freshly signed envelope", () => {
    const env = signEnvelope({ kid: KID, secret: SECRET, op: "ping", payload: { n: 1 } });
    const result = verify(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.op).toBe("ping");
      expect(result.envelope.payload).toEqual({ n: 1 });
    }
  });

  it("covers every declared op", () => {
    for (const op of AGENT_OPS) {
      const env = signEnvelope({ kid: KID, secret: SECRET, op });
      expect(verify(env).ok, op).toBe(true);
    }
  });

  it("rejects a tampered payload", () => {
    const env = signEnvelope({ kid: KID, secret: SECRET, op: "ping", payload: { n: 1 } });
    const result = verify({ ...env, payload: { n: 2 } });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an unknown kid", () => {
    const env = signEnvelope({ kid: "agk_other", secret: SECRET, op: "ping" });
    expect(verify(env)).toEqual({ ok: false, reason: "unknown_kid" });
  });

  it("rejects a bad signature", () => {
    const env = signEnvelope({ kid: KID, secret: SECRET, op: "ping" });
    expect(verify({ ...env, sig: "00".repeat(32) })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a replayed nonce", () => {
    const nonces = new NonceCache();
    const env = signEnvelope({ kid: KID, secret: SECRET, op: "ping" });
    expect(verify(env, { nonces }).ok).toBe(true);
    expect(verify(env, { nonces })).toEqual({ ok: false, reason: "replay" });
  });

  it("rejects a timestamp outside the 5 minute skew window", () => {
    const now = Date.now();
    const stale = signEnvelope({
      kid: KID,
      secret: SECRET,
      op: "ping",
      ts: now - AGENT_MAX_SKEW_MS - 1,
    });
    expect(verify(stale, { now })).toEqual({ ok: false, reason: "stale" });

    const future = signEnvelope({
      kid: KID,
      secret: SECRET,
      op: "ping",
      ts: now + AGENT_MAX_SKEW_MS + 1,
    });
    expect(verify(future, { now })).toEqual({ ok: false, reason: "stale" });
  });

  it("accepts a timestamp just inside the skew window", () => {
    const now = Date.now();
    const env = signEnvelope({
      kid: KID,
      secret: SECRET,
      op: "ping",
      ts: now - AGENT_MAX_SKEW_MS + 50,
    });
    expect(verify(env, { now }).ok).toBe(true);
  });

  it("rejects a malformed body", () => {
    expect(verify(null)).toEqual({ ok: false, reason: "bad_shape" });
    expect(verify({ v: 1 })).toEqual({ ok: false, reason: "bad_shape" });
    expect(verify({ ...signEnvelope({ kid: KID, secret: SECRET, op: "ping" }), op: "nope" })).toEqual({
      ok: false,
      reason: "bad_shape",
    });
  });
});
