import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The host-control resolver (#527) and its two-way relationship with the adapters
 * gate. Two properties are pinned here:
 *
 *  1. Precedence is the productMode direction — a stored value OVERRIDES the env
 *     (`--no-host-control`), because the operator's need is to re-enable from
 *     Settings "anytime" what the install flag turned off. This is the opposite of
 *     authMode, which pins env, and getting it backwards would strand a box the
 *     operator explicitly turned back on.
 *  2. adapters can't read the DB, so the resolved value is PUSHED into it via
 *     setHostControlOverride, flipping enabled→disabled polarity exactly once. The
 *     synchronous host-op gate (hostControlDisabled) must reflect the stored choice
 *     after a sync, so createHostExecutor / the self-server + listServers gates all
 *     agree with the client-facing effective value.
 */

const state = vi.hoisted(() => ({
  target: "selfhosted" as string,
  // What repos.instanceSettings.get() resolves to. `row: null` models "no settings
  // row yet"; otherwise hostControlEnabled carries the stored override.
  row: { hostControlEnabled: null as boolean | null } as { hostControlEnabled: boolean | null } | null,
}));

vi.mock("./controller-helpers", () => ({
  resolvePlatformConfig: () => ({ target: state.target }),
}));

vi.mock("@repo/db", () => ({
  repos: { instanceSettings: { get: async () => state.row } },
}));

// @repo/adapters is NOT mocked: the point is that syncHostControlOverride mutates
// the REAL adapters override that hostControlDisabled reads.
const { resolveHostControlEnabled, syncHostControlOverride, clearHostControlCache } = await import(
  "./host-control"
);
const { hostControlDisabled, setHostControlOverride } = await import("@repo/adapters");

beforeEach(() => {
  state.target = "selfhosted";
  state.row = { hostControlEnabled: null };
  clearHostControlCache();
  setHostControlOverride(null);
  delete process.env.OPENSHIP_HOST_CONTROL;
});

describe("resolveHostControlEnabled — precedence", () => {
  it("is false off a self-hosted target, whatever is stored or in the env", async () => {
    state.target = "desktop";
    state.row = { hostControlEnabled: true };
    process.env.OPENSHIP_HOST_CONTROL = "true";
    // Agrees with localServerOwnerOrg, which withholds the isLocal row off a
    // self-hosted target — the client gate must not advertise what the backend refuses.
    expect(await resolveHostControlEnabled()).toBe(false);
  });

  it("honours a stored TRUE over env=false (DB overrides the install flag)", async () => {
    process.env.OPENSHIP_HOST_CONTROL = "false"; // installed --no-host-control
    state.row = { hostControlEnabled: true }; // …then re-enabled from Settings
    expect(await resolveHostControlEnabled()).toBe(true);
  });

  it("honours a stored FALSE even with the env unset", async () => {
    state.row = { hostControlEnabled: false };
    expect(await resolveHostControlEnabled()).toBe(false);
  });

  it("falls back to the env default when nothing is stored", async () => {
    state.row = { hostControlEnabled: null };
    // Unset env → enabled by default.
    expect(await resolveHostControlEnabled()).toBe(true);

    clearHostControlCache();
    process.env.OPENSHIP_HOST_CONTROL = "false";
    expect(await resolveHostControlEnabled()).toBe(false);
  });

  it("falls back to the env default when there is no settings row at all", async () => {
    state.row = null;
    process.env.OPENSHIP_HOST_CONTROL = "false";
    expect(await resolveHostControlEnabled()).toBe(false);
  });
});

describe("syncHostControlOverride — pushes the disabled-polarity override into adapters", () => {
  it("stored FALSE disables the host gate", async () => {
    state.row = { hostControlEnabled: false };
    await syncHostControlOverride();
    expect(hostControlDisabled()).toBe(true);
  });

  it("stored TRUE enables the gate even when the env says false", async () => {
    process.env.OPENSHIP_HOST_CONTROL = "false";
    state.row = { hostControlEnabled: true };
    await syncHostControlOverride();
    expect(hostControlDisabled()).toBe(false);
  });

  it("stored NULL clears the override so the env floor governs again", async () => {
    // Prove it's the env, not a stale override: flip the env and re-sync.
    process.env.OPENSHIP_HOST_CONTROL = "false";
    state.row = { hostControlEnabled: null };
    await syncHostControlOverride();
    expect(hostControlDisabled()).toBe(true); // env floor

    delete process.env.OPENSHIP_HOST_CONTROL;
    await syncHostControlOverride();
    expect(hostControlDisabled()).toBe(false); // env floor, override still cleared
  });

  it("survives an unreadable settings table by clearing the override", async () => {
    state.row = { hostControlEnabled: true };
    await syncHostControlOverride();
    expect(hostControlDisabled()).toBe(false);

    // DB blips on the next read: sync must not throw, and must not leave the stale
    // enable latched — it clears the override so the env floor decides.
    const { repos } = await import("@repo/db");
    const getSpy = vi.spyOn(repos.instanceSettings, "get").mockRejectedValueOnce(new Error("db down"));
    process.env.OPENSHIP_HOST_CONTROL = "false";
    await expect(syncHostControlOverride()).resolves.toBeUndefined();
    expect(hostControlDisabled()).toBe(true); // fell back to the env floor
    getSpy.mockRestore();
  });
});
