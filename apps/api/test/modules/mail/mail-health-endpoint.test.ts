import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /mail/health/:serverId` answers two questions the Health tab asks together:
 * are the daemons up, and is mail actually leaving the box. They ride one response
 * because they ride one connection — the tab polls this every 10s, and a second
 * endpoint would double the SSH traffic to render two halves of one verdict.
 *
 * Pinned here:
 *   1. `delivery` is present, and its probe shares the executor (and therefore the
 *      memoized engine topology) with the daemon sweep.
 *   2. Neither half can blank the other. A queue we can't read still renders nine
 *      daemon rows; nine unknown daemons still render the send path.
 */

const withExecutor = vi.fn();
vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: (id: string, fn: (e: unknown) => unknown) => withExecutor(id, fn),
  },
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

import { getHealth } from "../../../src/modules/mail/mail.controller";
import { forgetMailEngine } from "../../../src/modules/mail/mail-engine";
import type { MailComponentHealth } from "../../../src/modules/mail/mail-health.service";
import type { MailDeliveryHealth } from "../../../src/modules/mail/mail-delivery.service";

const SERVER = "srv_1";

const RELAY = {
  enabled: true,
  provider: "ses",
  region: "us-east-1",
  host: "email-smtp.us-east-1.amazonaws.com",
  port: 587,
  username: "AKIAEXAMPLE",
  passwordEncrypted: "enc:…",
  scope: "all",
  updatedAt: new Date(0).toISOString(),
};

const QUEUE_STUCK = [
  "-Queue ID-  --Size-- ----Arrival Time---- -Sender/Recipient-------",
  "A1B2C3D4E5*     1234 Fri Aug  8 02:00:00  sender@example.com",
  "(host email-smtp.us-east-1.amazonaws.com[203.0.113.9] said: 535 Authentication Credentials Invalid)",
  "                                         rcpt@example.org",
  "",
  "-- 8 Kbytes in 42 Requests.",
].join("\n");

/** Answers the three probes this endpoint makes: detect, state read, queue read. */
function box(opts: { queue?: string | Error; relay?: boolean; unit?: string } = {}) {
  const state = JSON.stringify({
    version: 1,
    serverId: SERVER,
    domain: "example.com",
    startedAt: new Date(0).toISOString(),
    completedSteps: {},
    ...(opts.relay ? { outboundRelay: RELAY } : {}),
  });
  return {
    exec: vi.fn(async (cmd: string) => {
      if (cmd.includes("{{.Config.Image}}")) return "true\topenship/mail:latest";
      if (cmd.startsWith("cat ")) return state;
      if (cmd.includes("postqueue")) {
        const queue = opts.queue ?? "Mail queue is empty";
        if (queue instanceof Error) throw queue;
        return queue;
      }
      // The pg sidecar is inspected, not asked over supervisorctl — its probe
      // reports a bare boolean.
      if (cmd.includes("{{.State.Running}}")) return "true";
      if (opts.unit) return opts.unit;
      // supervisorctl names the program it reports on, and the parser checks that
      // — echo back whichever unit was asked for.
      const unit = /supervisorctl status '([^']+)'/.exec(cmd)?.[1] ?? "postfix";
      return `${unit}   RUNNING   pid 12, uptime 0:03:11`;
    }),
  };
}

let executor: ReturnType<typeof box>;

function context() {
  return {
    req: { param: (k: string) => (k === "serverId" ? SERVER : undefined) },
    json: (body: unknown) => body,
  } as never;
}

async function callHealth(): Promise<{
  serverId: string;
  components: MailComponentHealth[];
  delivery: MailDeliveryHealth;
}> {
  return (await getHealth(context())) as never;
}

function use(exec: ReturnType<typeof box>) {
  executor = exec;
  forgetMailEngine(exec as never);
  withExecutor.mockImplementation((_id: string, fn: (e: unknown) => unknown) => fn(exec));
}

beforeEach(() => {
  vi.clearAllMocks();
  use(box());
});

describe("GET /mail/health — outbound delivery", () => {
  it("reports the send path beside the daemons, on one connection", async () => {
    const body = await callHealth();

    expect(body.components).toHaveLength(9);
    expect(body.delivery).toMatchObject({ status: "ok", mode: "direct", queued: 0 });
    expect(withExecutor).toHaveBeenCalledTimes(1);
  });

  it("shares the engine probe with the daemon sweep instead of detecting twice", async () => {
    await callHealth();

    const detects = executor.exec.mock.calls
      .map(([cmd]) => cmd as string)
      .filter((cmd) => cmd.includes("{{.Config.Image}}"));
    expect(detects).toHaveLength(1);
  });

  /**
   * The defect this endpoint exists to catch: every daemon green, every DNS check
   * green, and not one message delivered since the relay password was mistyped.
   */
  it("fails delivery on a relayed box whose credentials the smarthost rejects", async () => {
    use(box({ relay: true, queue: QUEUE_STUCK }));

    const body = await callHealth();

    expect(body.components.every((c) => c.status === "active")).toBe(true);
    expect(body.delivery.status).toBe("fail");
    expect(body.delivery.queued).toBe(42);
    expect(body.delivery.relayHost).toBe("email-smtp.us-east-1.amazonaws.com:587");
    expect(body.delivery.deferrals[0]?.kind).toBe("auth");
  });

  it("still renders the daemons when the queue read fails", async () => {
    use(box({ queue: new Error("Command timed out after 30000ms") }));

    const body = await callHealth();

    expect(body.components.every((c) => c.status === "active")).toBe(true);
    expect(body.delivery.status).toBe("unknown");
    expect(body.delivery.detail).toContain("timed out");
  });

  it("still reports the send path when the daemon probes fail", async () => {
    use(box({ relay: true, unit: "Error response from daemon: No such container: openship-mail" }));

    const body = await callHealth();

    expect(body.components.find((c) => c.key === "postfix")?.status).toBe("unknown");
    expect(body.delivery.mode).toBe("relay");
    expect(body.delivery.status).toBe("ok");
  });

  it("still 500s when the server itself is unreachable", async () => {
    withExecutor.mockRejectedValue(new Error("connect ETIMEDOUT"));

    const body = (await getHealth(context())) as unknown as { error: string };

    expect(body.error).toContain("ETIMEDOUT");
  });
});
