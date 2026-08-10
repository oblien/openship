import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /mail/status` is the one request /emails already makes before rendering the
 * admin panel, so it is where the live engine topology belongs: the panel can then
 * state "the engine is stopped, here's the fix" ONCE, above the tab bar, instead of
 * ten tabs each discovering it as a 409 (or, before the gate, as a raw
 * "No such container: openship-mail-db" 500) with nothing to press.
 *
 * Two contracts are pinned here:
 *   1. The probe rides the SAME executor that reads the state file — no second
 *      connection, and none at all for a box that has no mail install.
 *   2. `engine` is OMITTED, never nulled or guessed, when the probe can't
 *      conclude. Absence means "we didn't look"; a failed read must never render
 *      as a broken mail server.
 */

vi.mock("@repo/adapters", () => ({
  detectMailEngine: vi.fn(),
  MAIL_CONTAINER: "openship-mail",
  MAIL_DB_CONTAINER: "openship-mail-db",
  MAIL_DB_NAME: "vmail",
  MAIL_HOST_PATHS: {
    saslPasswd: "/opt/openship/mail/postfix/sasl_passwd",
    senderRelayhost: "/opt/openship/mail/postfix/sender_relayhost",
    amavisUserConf: "/opt/openship/mail/amavis/50-user",
  },
}));

const withExecutor = vi.fn();
vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: (id: string, fn: (e: unknown) => unknown) => withExecutor(id, fn),
  },
}));

const readState = vi.fn();
vi.mock("../../../src/modules/mail/mail-state", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readState: (...args: unknown[]) => readState(...args),
}));

vi.mock("../../../src/lib/permission", () => ({
  permission: { assert: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../../src/lib/controller-helpers", () => ({
  isServerInOrg: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ userId: "u1", organizationId: "org1" }),
}));

import { detectMailEngine } from "@repo/adapters";
import { getStatus } from "../../../src/modules/mail/mail.controller";
import { forgetMailEngine } from "../../../src/modules/mail/mail-engine";

const SERVER = "srv_1";
/** Minimal state: no dnsRecords and no webmail, so neither augment step runs. */
const STATE = {
  serverId: SERVER,
  domain: "example.com",
  startedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  completedSteps: {},
};

/** One executor identity per test, so the per-executor probe memo can't leak. */
let executor: { exec: ReturnType<typeof vi.fn> };

function context() {
  const json = vi.fn((body: unknown) => body);
  return {
    req: { query: (k: string) => (k === "serverId" ? SERVER : undefined) },
    json,
  } as never;
}

async function callStatus(): Promise<Record<string, unknown>> {
  return (await getStatus(context())) as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  executor = { exec: vi.fn() };
  forgetMailEngine(executor as never);
  readState.mockResolvedValue(STATE);
  withExecutor.mockImplementation((_id: string, fn: (e: unknown) => unknown) => fn(executor));
  vi.mocked(detectMailEngine).mockResolvedValue({
    flavor: "container",
    running: true,
    exists: true,
    image: "ghcr.io/oblien/openship-mail:0.5.0",
  });
});

describe("GET /mail/status — engine state", () => {
  it("reports a serving containerized engine on the same executor as the state read", async () => {
    const body = await callStatus();

    expect(body.engine).toEqual({ flavor: "container", running: true });
    // One connection for both reads — the probe must not open its own.
    expect(withExecutor).toHaveBeenCalledTimes(1);
    expect(vi.mocked(detectMailEngine).mock.calls[0]?.[0]).toBe(executor);
  });

  it("reports a LEGACY host engine that is stopped, so the panel can offer the repair", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue({
      flavor: "host",
      running: false,
      exists: true,
      image: null,
    });

    expect((await callStatus()).engine).toEqual({ flavor: "host", running: false });
  });

  it("reports a box whose engine is gone as flavor none", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue({
      flavor: "none",
      running: false,
      exists: false,
      image: null,
    });

    expect((await callStatus()).engine).toEqual({ flavor: "none", running: false });
  });

  it("OMITS engine when the probe fails — a failed read is not 'no engine'", async () => {
    vi.mocked(detectMailEngine).mockRejectedValue(new Error("ssh channel closed"));

    const body = await callStatus();

    expect("engine" in body).toBe(false);
    // The rest of the status still renders: one broken probe can't blank the panel.
    expect(body.serverId).toBe(SERVER);
    expect(body.domain).toBe("example.com");
  });

  it("doesn't probe a server with no mail install at all", async () => {
    readState.mockResolvedValue(null);

    const body = await callStatus();

    expect("engine" in body).toBe(false);
    expect(body.active).toBe(false);
    expect(detectMailEngine).not.toHaveBeenCalled();
  });

  it("still answers the no-install shell when the server is unreachable", async () => {
    withExecutor.mockRejectedValue(new Error("connect ETIMEDOUT"));

    const body = await callStatus();

    expect("engine" in body).toBe(false);
    expect(body.active).toBe(false);
    expect(body.serverId).toBe(SERVER);
  });
});
