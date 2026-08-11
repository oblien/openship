import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A DEFAULT deploy target is a binding: a server row, or a cloud workspace.
 *
 * "local" is not one — it's what a project with neither DERIVES at deploy time — and
 * storing it as a preference is how a VPS ended up reporting `http://localhost:<port>`
 * for its own deploys: the picked default dropped the "This Server" row's real
 * address, for the same machine the row already described.
 *
 * So it is rejected on write and, since it may already sit in a row, read back as
 * "no preference" rather than replayed into the wizard.
 */

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  upserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    settings: {
      findByUser: async () => h.row,
      upsert: async (values: Record<string, unknown>) => {
        h.upserts.push(values);
      },
      update: async (_userId: string, values: Record<string, unknown>) => {
        h.updates.push(values);
      },
    },
  },
}));

vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({ userId: "u1", organizationId: "org1", role: "owner" }),
}));

vi.mock("../../lib/audit", () => ({
  audit: { recordAsync: () => {} },
  auditContextFrom: () => ({}),
}));

vi.mock("../../lib/encryption", () => ({ encrypt: (v: string) => v }));

const { updateDeployDefaults } = await import("./settings.controller");
const { isValidDefaultDeployTarget, getDeployDefaults } = await import("./settings.service");

/** Enough of a Hono context for this handler: a JSON body in, a JSON reply out. */
function context(body: unknown) {
  const sent: { body: unknown; status: number } = { body: undefined, status: 0 };
  const c = {
    req: { json: async () => body },
    json: (payload: unknown, status = 200) => {
      sent.body = payload;
      sent.status = status;
      return payload as never;
    },
  };
  return { c: c as never, sent };
}

beforeEach(() => {
  h.row = null;
  h.upserts = [];
  h.updates = [];
});

describe("isValidDefaultDeployTarget", () => {
  it("accepts the two real destinations and nothing else", () => {
    expect(isValidDefaultDeployTarget("server")).toBe(true);
    expect(isValidDefaultDeployTarget("cloud")).toBe(true);
    // The one that matters: `DeployTarget` in @repo/core still HAS "local", so this
    // predicate is what keeps a derived value out of a stored preference.
    expect(isValidDefaultDeployTarget("local")).toBe(false);
    expect(isValidDefaultDeployTarget("")).toBe(false);
    expect(isValidDefaultDeployTarget(null)).toBe(false);
  });
});

describe("PATCH /deploy-defaults", () => {
  it("rejects 'local' with a 400 that names what IS accepted", async () => {
    const { c, sent } = context({ defaultDeployTarget: "local" });
    await updateDeployDefaults(c);
    expect(sent.status).toBe(400);
    expect((sent.body as { error: string }).error).toMatch(/'server', 'cloud', or null/);
    // Nothing written: a rejected value must not half-land as a cleared default.
    expect(h.upserts).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("still clears on null, and still stores the two real targets", async () => {
    const cleared = context({ defaultDeployTarget: null });
    await updateDeployDefaults(cleared.c);
    expect(cleared.sent.status).toBe(200);
    expect(h.upserts[0]?.defaultDeployTarget).toBeNull();

    const cloud = context({ defaultDeployTarget: "cloud" });
    await updateDeployDefaults(cloud.c);
    expect(cloud.sent.body).toEqual({ defaultDeployTarget: "cloud", defaultServerId: null });

    const server = context({ defaultDeployTarget: "server", defaultServerId: "srv-1" });
    await updateDeployDefaults(server.c);
    expect(server.sent.body).toEqual({ defaultDeployTarget: "server", defaultServerId: "srv-1" });
  });

  it("a server default still requires the server it binds to", async () => {
    const { c, sent } = context({ defaultDeployTarget: "server" });
    await updateDeployDefaults(c);
    expect(sent.status).toBe(400);
    expect((sent.body as { error: string }).error).toMatch(/defaultServerId is required/);
  });
});

describe("getDeployDefaults", () => {
  it("reads a legacy stored 'local' back as no preference", async () => {
    // Rows written before "local" stopped being offered. Replaying one would re-select
    // a target the picker has no card for, so it reads as "unset" and the wizard's
    // auto-pick lands on this box's own server row — with its real address.
    h.row = { defaultDeployTarget: "local", defaultServerId: null };
    await expect(getDeployDefaults("u1")).resolves.toEqual({
      defaultDeployTarget: null,
      defaultServerId: null,
    });
  });

  it("passes a real stored target through", async () => {
    h.row = { defaultDeployTarget: "server", defaultServerId: "srv-1" };
    await expect(getDeployDefaults("u1")).resolves.toEqual({
      defaultDeployTarget: "server",
      defaultServerId: "srv-1",
    });
  });
});
