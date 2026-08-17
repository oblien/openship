import { describe, expect, it } from "vitest";
import {
  AGENT_MAX_SKEW_MS,
  NonceCache,
  signEnvelope,
  verifyEnvelope,
} from "@repo/core/agent-protocol";
import {
  agentInstallSnippet,
  publicAgentStatus,
  resolveControlPlaneUrl,
  stripPendingOps,
} from "./server-agent";
import type { Server } from "@repo/db";

function server(partial: Partial<Server> = {}): Server {
  return {
    id: "srv_1",
    organizationId: "org_1",
    name: "box",
    isLocal: false,
    sshHost: "10.0.0.2",
    sshPort: 22,
    sshUser: "root",
    sshAuthMethod: "key",
    sshPassword: null,
    sshKeyPath: null,
    sshPrivateKey: null,
    sshKeyPassphrase: null,
    sshJumpHost: null,
    sshArgs: null,
    agent: null,
    agentSecret: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

describe("agent install snippet", () => {
  it("writes the config and starts a host-network container", () => {
    const snippet = agentInstallSnippet({
      serverId: "srv_1",
      keyId: "agk_abc",
      secret: "sekrit",
      controlPlaneUrl: "http://127.0.0.1:4000/",
    });
    expect(snippet).toContain("/etc/openship/agent.json");
    expect(snippet).toContain('"serverId": "srv_1"');
    expect(snippet).toContain('"keyId": "agk_abc"');
    expect(snippet).toContain('"sharedSecret": "sekrit"');
    expect(snippet).toContain("http://127.0.0.1:4000");
    expect(snippet).not.toContain("http://127.0.0.1:4000/");
    expect(snippet).toContain("docker run -d --name openship-agent");
    expect(snippet).toContain("--network host");
  });
});

describe("public agent status", () => {
  it("is not enrolled when there is no secret", () => {
    expect(publicAgentStatus(server()).enrolled).toBe(false);
    expect(
      publicAgentStatus(
        server({
          agent: {
            enrolledAt: "2026-01-01T00:00:00.000Z",
            keyId: "agk_x",
            lastSeenAt: null,
            capabilities: [],
            version: null,
          },
        }),
      ).enrolled,
    ).toBe(false);
  });

  it("hides pending ops from the public view", () => {
    const stripped = stripPendingOps({
      enrolledAt: "2026-01-01T00:00:00.000Z",
      keyId: "agk_x",
      lastSeenAt: null,
      capabilities: ["ping"],
      version: "0.6.6",
      pendingOps: [{ id: "opq_1", op: "ping", payload: {}, queuedAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(stripped).toEqual({
      enrolledAt: "2026-01-01T00:00:00.000Z",
      keyId: "agk_x",
      lastSeenAt: null,
      capabilities: ["ping"],
      version: "0.6.6",
    });
    expect(publicAgentStatus(server({ agent: stripped, agentSecret: "enc1:x" }))).toMatchObject({
      enrolled: true,
      keyId: "agk_x",
      version: "0.6.6",
    });
  });
});

describe("control plane URL", () => {
  it("prefers an explicit enroll URL and strips a trailing slash", () => {
    expect(resolveControlPlaneUrl("https://ops.example.com/", "http://ignored")).toBe(
      "https://ops.example.com",
    );
  });
});

describe("signed dispatch envelope", () => {
  it("round-trips sign/verify and rejects replay and skew", () => {
    const kid = "agk_cp";
    const secret = "control-plane-secret";
    const nonces = new NonceCache();
    const env = signEnvelope({ kid, secret, op: "renew_certs", payload: { domains: ["a.test"] } });
    const opts = { secretForKid: (k: string) => (k === kid ? secret : undefined), nonces };
    expect(verifyEnvelope(env, opts).ok).toBe(true);
    expect(verifyEnvelope(env, opts)).toEqual({ ok: false, reason: "replay" });
    expect(
      verifyEnvelope(
        signEnvelope({ kid, secret, op: "ping", ts: Date.now() - AGENT_MAX_SKEW_MS - 5 }),
        { ...opts, nonces: new NonceCache() },
      ),
    ).toEqual({ ok: false, reason: "stale" });
  });
});
