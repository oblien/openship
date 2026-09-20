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

vi.mock("@repo/platform/engine/lib/encryption", () => ({ encrypt: (v: string) => v }));

const { updateDeployDefaults } = await import("@repo/platform/engine/modules/settings/preferences.service");
const { isValidDefaultDeployTarget, getDeployDefaults } = await import("@repo/platform/engine/modules/settings/settings.service");

const ctx = { userId: "u1", organizationId: "org1", role: "owner" } as never;

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

describe("deploy defaults application service", () => {
  it("rejects a derived local target before persistence", async () => {
    await expect(updateDeployDefaults(ctx, { defaultDeployTarget: "local" } as never))
      .rejects.toMatchObject({ statusCode: 400, message: "defaultDeployTarget must be 'server', 'cloud', or null" });
    expect(h.upserts).toEqual([]);
    expect(h.updates).toEqual([]);
  });
  it("still clears on null and stores the two explicit targets", async () => {
    await expect(updateDeployDefaults(ctx, { defaultDeployTarget: null }))
      .resolves.toEqual({ defaultDeployTarget: null, defaultServerId: null });
    expect(h.upserts[0]?.defaultDeployTarget).toBeNull();
    await expect(updateDeployDefaults(ctx, { defaultDeployTarget: "cloud" }))
      .resolves.toEqual({ defaultDeployTarget: "cloud", defaultServerId: null });
    await expect(updateDeployDefaults(ctx, { defaultDeployTarget: "server", defaultServerId: "srv-1" }))
      .resolves.toEqual({ defaultDeployTarget: "server", defaultServerId: "srv-1" });
  });
  it("requires a server binding when selecting a server target", async () => {
    await expect(updateDeployDefaults(ctx, { defaultDeployTarget: "server" }))
      .rejects.toMatchObject({ statusCode: 400, message: "defaultServerId is required when defaultDeployTarget='server'" });
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

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { recordAsync: () => {} },
  operationAuditContext: () => ({}),
}));
