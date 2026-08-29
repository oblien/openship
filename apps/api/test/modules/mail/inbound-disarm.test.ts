/**
 * Every mutation that narrows what is watched must RELEASE the BCC it orphans.
 *
 * GH-559: an armed domain makes Postfix BCC a full second copy of every message into a
 * collector mailbox provisioned at QUOTA 0, and the only thing that prunes those copies is
 * the read job visiting that domain. Disabling a rule (or moving its scope) stopped the
 * pruning while the copies kept arriving, on /var/vmail — a bind mount with no quota of its
 * own. The disk fills and the mail server goes down.
 *
 * Only `deleteRuleHandler` released anything; `updateRuleHandler` armed on a scope change
 * and disarmed nothing, and `enabled: false` disarmed nothing at all. These tests pin the
 * release on each path, and pin the thing that makes it SAFE: a domain a second enabled
 * rule still covers must stay armed, because capture is domain-keyed and shared.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

const engine = vi.hoisted(() => ({
  armed: [] as string[],
  disarmed: [] as string[],
  domains: ["acme.com", "beta.com"],
}));

vi.mock("../../../src/modules/mail/inbound/capture", () => ({
  armDomain: vi.fn(async (_s: string, d: string) => {
    engine.armed.push(d);
    return "tok";
  }),
  disarmDomain: vi.fn(async (_s: string, d: string) => {
    engine.disarmed.push(d);
  }),
  listEngineDomains: vi.fn(async () => engine.domains),
  ruleDomain: ({ scope, target }: { scope: string; target: string | null }) =>
    scope === "domain" ? target : scope === "mailbox" ? (target?.split("@")[1] ?? null) : null,
  ForeignBccError: class extends Error {},
}));

vi.mock("../../../src/modules/mail/inbound/read", () => ({
  runInboundForServer: vi.fn(async () => ({ read: 0, emitted: 0, dropped: 0, errors: [] })),
}));

/** Rule rows, keyed by id. `enabled` drives the "still wanted" computation. */
type Row = {
  id: string;
  serverId: string;
  organizationId: string;
  scope: string;
  target: string | null;
  enabled: boolean;
};
const db = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));

vi.mock("@repo/db", () => ({
  repos: {
    mailInbound: {
      findById: vi.fn(async (_org: string, id: string) => db.rows.get(id)),
      update: vi.fn(async (_org: string, id: string, patch: Record<string, unknown>) => {
        const cur = db.rows.get(id) as Row | undefined;
        if (!cur) return undefined;
        const next = { ...cur, ...patch };
        db.rows.set(id, next);
        return next;
      }),
      remove: vi.fn(async (_org: string, id: string) => {
        db.rows.delete(id);
      }),
      listEnabledByServer: vi.fn(async (serverId: string) =>
        [...db.rows.values()].filter((r) => (r as Row).serverId === serverId && (r as Row).enabled),
      ),
    },
  },
}));

vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "org1" }),
}));
vi.mock("../../../src/lib/permission", () => ({
  permission: { assert: vi.fn(async () => undefined) },
}));
vi.mock("../../../src/lib/controller-helpers", () => ({
  param: (_c: unknown, name: string) => (name === "serverId" ? "srv1" : "r1"),
  isServerInOrg: vi.fn(async () => true),
  assertNotCloud: () => null,
}));

import {
  updateRuleHandler,
  deleteRuleHandler,
} from "../../../src/modules/mail/inbound/inbound.controller";

/** Minimal hono Context: a JSON body in, a captured JSON response out. */
function ctx(body: unknown) {
  const sent: { body?: unknown; status?: number } = {};
  return {
    c: {
      req: { json: async () => body },
      json: (b: unknown, status?: number) => {
        sent.body = b;
        sent.status = status ?? 200;
        return sent;
      },
    } as never,
    sent,
  };
}

function seed(rows: Row[]) {
  db.rows.clear();
  for (const r of rows) db.rows.set(r.id, r);
}

const RULE: Row = {
  id: "r1",
  serverId: "srv1",
  organizationId: "org1",
  scope: "domain",
  target: "acme.com",
  enabled: true,
};

beforeEach(() => {
  engine.armed = [];
  engine.disarmed = [];
  engine.domains = ["acme.com", "beta.com"];
});

describe("inbound rule mutations release the BCC they orphan (GH-559)", () => {
  it("disabling a rule disarms its domain", async () => {
    seed([{ ...RULE }]);
    const { c } = ctx({ enabled: false });
    await updateRuleHandler(c);

    expect(engine.disarmed).toEqual(["acme.com"]);
    // A disabled rule must not be left armed either.
    expect(engine.armed).toEqual([]);
  });

  it("re-enabling a rule arms it again", async () => {
    // The old code only armed inside the scope branch, so a resumed rule watched nothing.
    seed([{ ...RULE, enabled: false }]);
    const { c } = ctx({ enabled: true });
    await updateRuleHandler(c);

    expect(engine.armed).toEqual(["acme.com"]);
    expect(engine.disarmed).toEqual([]);
  });

  it("retargeting a domain rule releases the domain it left", async () => {
    seed([{ ...RULE }]);
    const { c } = ctx({ scope: "domain", target: "beta.com" });
    await updateRuleHandler(c);

    expect(engine.armed).toEqual(["beta.com"]);
    expect(engine.disarmed).toEqual(["acme.com"]);
  });

  it("keeps a domain armed when a second enabled rule still covers it", async () => {
    // The invariant that makes the release safe: capture is domain-keyed and SHARED.
    seed([
      { ...RULE },
      { id: "r2", serverId: "srv1", organizationId: "org1", scope: "domain", target: "acme.com", enabled: true },
    ]);
    const { c } = ctx({ enabled: false });
    await updateRuleHandler(c);

    expect(engine.disarmed).toEqual([]);
  });

  it("does not release a domain another rule covers via scope:all", async () => {
    seed([
      { ...RULE },
      { id: "r2", serverId: "srv1", organizationId: "org1", scope: "all", target: null, enabled: true },
    ]);
    const { c } = ctx({ enabled: false });
    await updateRuleHandler(c);

    // scope:all resolves to every engine domain, acme.com included.
    expect(engine.disarmed).toEqual([]);
  });

  it("deleting a rule still releases its domain", async () => {
    seed([{ ...RULE }]);
    const { c } = ctx({});
    await deleteRuleHandler(c);

    expect(engine.disarmed).toEqual(["acme.com"]);
  });

  it("a mailbox-scoped rule releases the domain behind the address", async () => {
    seed([{ ...RULE, scope: "mailbox", target: "support@acme.com" }]);
    const { c } = ctx({ enabled: false });
    await updateRuleHandler(c);

    expect(engine.disarmed).toEqual(["acme.com"]);
  });
});
