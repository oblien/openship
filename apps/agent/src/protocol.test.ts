import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceCache, signEnvelope, verifyEnvelope } from "./protocol";
import { OperationJournal } from "./journal";
import { handleSignedOp } from "./server";
import type { AgentConfig } from "./config";

const SECRET = "agent-test-secret";
const KID = "agk_agent";

function runtime() {
  const dir = mkdtempSync(join(tmpdir(), "osh-agent-proto-"));
  const config: AgentConfig = {
    controlPlaneUrl: "http://127.0.0.1:9",
    serverId: "srv_1",
    keyId: KID,
    sharedSecret: SECRET,
    listenHost: "127.0.0.1",
    listenPort: 0,
    heartbeatSeconds: 30,
    journalPath: join(dir, "journal.jsonl"),
  };
  return {
    config,
    journal: new OperationJournal(config.journalPath),
    nonces: new NonceCache(),
  };
}

describe("agent envelope handling", () => {
  it("accepts a signed ping and journals it as done", async () => {
    const rt = runtime();
    const env = signEnvelope({ kid: KID, secret: SECRET, op: "ping", payload: { opId: "op_ping" } });
    const out = await handleSignedOp(rt, env);
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(rt.journal.isDone("op_ping")).toBe(true);
  });

  it("rejects a replayed envelope", async () => {
    const rt = runtime();
    const env = signEnvelope({ kid: KID, secret: SECRET, op: "ping" });
    expect((await handleSignedOp(rt, env)).status).toBe(200);
    const again = await handleSignedOp(rt, env);
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("replay");
  });

  it("rejects skew / unknown kid / bad signature", () => {
    const nonces = new NonceCache();
    const opts = {
      secretForKid: (kid: string) => (kid === KID ? SECRET : undefined),
      nonces,
      now: Date.now(),
    };
    const fresh = signEnvelope({ kid: KID, secret: SECRET, op: "ping" });
    expect(verifyEnvelope(fresh, opts).ok).toBe(true);

    const stale = signEnvelope({ kid: KID, secret: SECRET, op: "ping", ts: Date.now() - 6 * 60 * 1000 });
    expect(verifyEnvelope(stale, { ...opts, nonces: new NonceCache() })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(
      verifyEnvelope(signEnvelope({ kid: "agk_nope", secret: SECRET, op: "ping" }), {
        ...opts,
        nonces: new NonceCache(),
      }),
    ).toEqual({ ok: false, reason: "unknown_kid" });
  });
});
