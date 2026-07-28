import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * takeoverOnMigrate is the ONE home for the "user chose migrate → take over"
 * catch body that used to be copy-pasted in the deploy pipeline and the
 * server-setup installer. Mock the takeover engine and lock the wrapper's
 * contract: announce the migration, forward status/sites/acmeEmail, stream both
 * the pre-scan warnings and the takeover warnings, and return the raw result.
 */

const h = vi.hoisted(() => ({ runEdgeTakeover: vi.fn() }));
vi.mock("./takeover", () => ({ runEdgeTakeover: h.runEdgeTakeover }));

beforeEach(() => vi.clearAllMocks()); // isolate call history per test

import { takeoverOnMigrate, ensureEdge } from "./index";
import { EdgeMigrateRequested } from "./detect";
import type { CommandExecutor } from "../../types";

describe("takeoverOnMigrate", () => {
  it("forwards status/sites/acmeEmail, streams warnings, returns the takeover result", async () => {
    h.runEdgeTakeover.mockResolvedValue({
      ok: true,
      rolledBack: false,
      registered: ["a.example.com"],
      warnings: ["takeover-warn"],
    });
    const logs: string[] = [];
    const migrate = new EdgeMigrateRequested(
      { classification: "known", canProceedClean: false, occupants: [] },
      [{ serverNames: ["a.example.com"], ssl: false, target: { kind: "proxy", url: "http://127.0.0.1:3000" } }],
      ["scan-warn"],
    );
    const exec = {} as CommandExecutor;

    const res = await takeoverOnMigrate(exec, migrate, {
      onLog: (l) => logs.push(l.message),
      acmeEmail: "ops@example.com",
    });

    expect(res.ok).toBe(true);
    expect(res.registered).toEqual(["a.example.com"]);
    expect(h.runEdgeTakeover).toHaveBeenCalledWith(
      exec,
      expect.objectContaining({ acmeEmail: "ops@example.com", sites: migrate.sites, status: migrate.status }),
      expect.any(Function),
    );
    expect(logs.some((m) => m.includes("Migrating 1 site"))).toBe(true);
    expect(logs).toContain("scan-warn"); // migrate.warnings forwarded
    expect(logs).toContain("takeover-warn"); // takeover.warnings forwarded
  });

  it("returns a not-ok result (rolled back) without throwing", async () => {
    h.runEdgeTakeover.mockResolvedValue({ ok: false, rolledBack: true, registered: [], warnings: ["boom"] });
    const migrate = new EdgeMigrateRequested(
      { classification: "known", canProceedClean: false, occupants: [] },
      [],
      [],
    );
    const res = await takeoverOnMigrate({} as CommandExecutor, migrate, { onLog: () => {} });
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
  });
});

describe("ensureEdge (single edge-prepare orchestrator)", () => {
  const exec = {} as CommandExecutor;
  const onLog = () => {};

  it("install succeeds → { migrated:false, value } and NO takeover", async () => {
    const res = await ensureEdge(exec, async () => ({ component: "openresty", success: true }), { onLog });
    expect(res).toEqual({ migrated: false, value: { component: "openresty", success: true } });
    expect(h.runEdgeTakeover).not.toHaveBeenCalled();
  });

  it("threads promptUser into the install step (the show-and-wait channel)", async () => {
    const install = vi.fn(async () => "ok");
    const promptUser = vi.fn();
    await ensureEdge(exec, install, { promptUser, onLog });
    expect(install).toHaveBeenCalledWith(promptUser);
  });

  it("install raises EdgeMigrateRequested → runs the takeover → { migrated:true, ok:true }", async () => {
    h.runEdgeTakeover.mockResolvedValue({ ok: true, rolledBack: false, registered: ["a.example.com"], warnings: [] });
    const migrate = new EdgeMigrateRequested(
      { classification: "known", canProceedClean: false, occupants: [] },
      [],
      [],
    );
    const res = await ensureEdge(exec, async () => { throw migrate; }, { onLog });
    expect(res).toEqual({ migrated: true, ok: true, registered: ["a.example.com"] });
  });

  it("a non-migrate error from install is rethrown (not swallowed)", async () => {
    await expect(
      ensureEdge(exec, async () => { throw new Error("apt failed"); }, { onLog }),
    ).rejects.toThrow("apt failed");
  });
});
