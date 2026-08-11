import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * What a module scan says when it could NOT decide.
 *
 * Two ways to answer "is this box behind" wrongly, both of which read to an operator
 * as "everything is fine here":
 *   - the reconcile dry run failed (unreadable manifest, a catalog serial below the
 *     box's high-water, a malformed version) and only its step counts were read, so
 *     the row came back up-to-date with no cause anywhere on it;
 *   - the container→host channel is firewalled (#490) or was never provisioned
 *     (#509), so every exec refuses with the remedy attached — and the presence probe
 *     turned that into "the module isn't installed", i.e. a server with no components
 *     and no reason given.
 */

const h = vi.hoisted(() => ({
  exec: vi.fn(async (_cmd: string) => ""),
  reconcile: vi.fn(),
  upsert: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));

vi.mock("@repo/db", () => ({
  repos: {
    serverModuleStatus: {
      upsert: h.upsert,
      remove: h.remove,
      setInProgress: vi.fn(async () => {}),
    },
    server: { list: vi.fn(async () => []) },
  },
}));

// The real error class + predicate: a hand-rolled stand-in would keep passing after
// the service and the adapters stopped agreeing on what "host unavailable" is.
vi.mock("@repo/adapters", async () => {
  const errors = await import("../../../../../packages/adapters/src/system/errors");
  return {
    HostChannelUnavailableError: errors.HostChannelUnavailableError,
    isHostChannelUnavailableError: errors.isHostChannelUnavailableError,
    resolveEnvironment: async () => ({ isRoot: true }),
    resolveVerifiedCatalog: async () => ({ catalog: { latest: "2.0.0", serial: 3, versions: [] }, assets: new Map() }),
    reconcileServerModule: h.reconcile,
    readManifest: async () => ({ migrationVersion: "1.0.0" }),
    ourEdgeContainerRunning: async () => false,
  };
});

vi.mock("../../lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: async (_id: string, fn: (e: unknown) => Promise<unknown>) =>
      fn({ exec: h.exec, writeFile: vi.fn(), readFile: vi.fn() }),
  },
}));

import { HostChannelUnavailableError } from "@repo/adapters";
import { scanServer } from "./server-modules.service";
import { HOST_CHANNEL_NOT_PROVISIONED } from "@repo/core";

const server = { id: "srv1", organizationId: "org1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.exec.mockImplementation(async () => "openresty/1.25.3.1");
  h.reconcile.mockResolvedValue({
    module: "openresty",
    fromVersion: "1.0.0",
    toVersion: "1.0.0",
    appliedSteps: [],
    pendingConsent: [],
    skipped: [],
    changed: false,
    ok: true,
  });
});

describe("scanServer — a check that failed is not an up-to-date box", () => {
  it("carries the runner's reason onto the row instead of reporting no drift", async () => {
    h.reconcile.mockResolvedValue({
      module: "openresty",
      fromVersion: "1.0.0",
      toVersion: "1.0.0",
      appliedSteps: [],
      pendingConsent: [],
      skipped: [],
      changed: false,
      ok: false,
      error: "catalog serial 2 < on-box high-water 3 (refusing downgrade)",
    });

    const [view] = await scanServer(server);
    expect(view?.behind).toBe(false);
    expect(view?.note).toContain("refusing downgrade");
    // And the operator-visible row, not just the in-memory view.
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ note: expect.stringContaining("refusing downgrade") }),
      }),
    );
  });

  it("a working dry run still reports drift as before", async () => {
    h.reconcile.mockResolvedValue({
      module: "openresty",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      appliedSteps: ["lua-2.0.0"],
      pendingConsent: [],
      skipped: [],
      changed: false,
      ok: true,
    });
    const [view] = await scanServer(server);
    expect(view?.behind).toBe(true);
    expect(view?.note).toBeUndefined();
  });
});

describe("scanServer — a dead host channel names itself", () => {
  it("propagates the channel's remedy rather than reporting zero modules", async () => {
    h.exec.mockRejectedValue(
      new HostChannelUnavailableError("not_configured", `no host channel. ${HOST_CHANNEL_NOT_PROVISIONED}`),
    );
    // The controller turns this into `scan failed: <message>`; what matters is that the
    // message is the channel's own remedy and not an empty, cause-less module list.
    await expect(scanServer(server)).rejects.toThrow(/openship up/);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("an ordinary non-zero probe still means 'not installed', with no row", async () => {
    h.exec.mockRejectedValue(new Error("exit 1"));
    await expect(scanServer(server)).resolves.toEqual([]);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
