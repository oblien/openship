import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CommandExecutor } from "../../types";
import type { EdgeStatus, ImportedSite } from "../types";

/**
 * Atomicity test for runEdgeTakeover: any failure after we stop the foreign
 * proxy must roll it back (re-enable it) so 80/443 are never left dark. All
 * infra deps are mocked — this asserts the forward/rollback control flow, not
 * a live OpenResty install (that's the Colima E2E).
 */

const h = vi.hoisted(() => ({
  installContainerEdge: vi.fn(),
  checkEdge: vi.fn(),
  detectPaths: vi.fn(),
  registerRoute: vi.fn(),
  provisionCert: vi.fn(),
  installCert: vi.fn(),
  freeEdgeTargets: vi.fn(async () => ({ freed: true, stillBound: [] as number[] })),
  resolveOurEdgeContainer: vi.fn(async () => null as string | null),
  containerEdgeProvider: vi.fn(),
}));

vi.mock("../installer", () => ({ installContainerEdge: h.installContainerEdge }));
vi.mock("../checks", () => ({ checkEdge: h.checkEdge }));
// Partial mock: only `detectOpenRestyPaths` is faked, since it's the one that
// shells out. The path/mount CONSTANTS pass through from the real module —
// hand-writing them here meant that adding an export (`EDGE_CONTAINER_MOUNTS`,
// dereferenced at module load two hops down the `./takeover` import chain)
// collapsed this whole suite to zero collected tests.
vi.mock("../../infra/openresty-lua", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/openresty-lua")>()),
  detectOpenRestyPaths: h.detectPaths,
}));
vi.mock("../../infra/nginx", () => ({
  NginxProvider: class {
    registerRoute = h.registerRoute;
    provisionCert = h.provisionCert;
    installCert = h.installCert;
  },
}));
vi.mock("./ensure-container-edge", () => ({ containerEdgeProvider: h.containerEdgeProvider }));
vi.mock("./detect", () => ({
  freeEdgeTargets: h.freeEdgeTargets,
  stopTargetsForStatus: () => [],
  resolveOurEdgeContainer: h.resolveOurEdgeContainer,
  sq: (s: string) => `'${s}'`,
  // The rollback stops OUR edge container before restoring a foreign proxy.
  EDGE_CONTAINER_NAME: "openship-edge",
}));

import { runEdgeTakeover } from "./takeover";

const STATUS: EdgeStatus = {
  classification: "known",
  canProceedClean: false,
  occupants: [
    { port: 80, systemdUnit: "nginx.service", proxy: "nginx", managedByOpenship: false },
  ],
};
const SITES: ImportedSite[] = [
  { serverNames: ["app.example.com"], ssl: false, target: { kind: "proxy", url: "http://127.0.0.1:3000" } },
];

function makeExecutor(opts: { portServedAfterRollback?: boolean } = {}) {
  const cmds: string[] = [];
  const executor = {
    exec: vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("is-enabled")) return "enabled"; // journal: foreign proxy was enabled
      // The rollback VERIFIES :80 is served again before claiming success.
      if (cmd.includes("/proc/net/tcp") || cmd.includes("ss -ltn")) {
        return opts.portServedAfterRollback === false ? "" : "yes";
      }
      return "";
    }),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
  } as unknown as CommandExecutor;
  return { executor, cmds };
}

/** Did rollback re-enable the foreign proxy (nginx.service)? */
const rolledBackNginx = (cmds: string[]) =>
  cmds.some((c) => c.includes("enable --now") && c.includes("nginx.service"));

const noop = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  h.freeEdgeTargets.mockImplementation(async () => ({ freed: true, stillBound: [] }));
  h.detectPaths.mockResolvedValue({});
  h.registerRoute.mockResolvedValue(undefined);
  h.provisionCert.mockResolvedValue({ verified: true });
  h.checkEdge.mockResolvedValue({ healthy: true, message: "ok" });
});

describe("runEdgeTakeover", () => {
  it("happy path: registers sites, marks complete, does NOT roll back", async () => {
    h.installContainerEdge.mockResolvedValue({ success: true });
    const { executor, cmds } = makeExecutor();

    const res = await runEdgeTakeover(executor, { status: STATUS, sites: SITES }, noop);

    expect(res.ok).toBe(true);
    expect(res.rolledBack).toBe(false);
    expect(res.registered).toEqual(["app.example.com"]);
    expect(h.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "app.example.com", targetUrl: "http://127.0.0.1:3000" }),
    );
    expect(rolledBackNginx(cmds)).toBe(false); // foreign proxy stays stopped
  });

  it("rolls back when OpenResty install fails (never leaves the box dark)", async () => {
    h.installContainerEdge.mockResolvedValue({ success: false, error: "install boom" });
    const { executor, cmds } = makeExecutor();

    const res = await runEdgeTakeover(executor, { status: STATUS, sites: SITES }, noop);

    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(res.warnings).toContain("install boom");
    expect(rolledBackNginx(cmds)).toBe(true); // foreign proxy restored
    expect(h.registerRoute).not.toHaveBeenCalled();
  });

  // `rolledBack: true` is what the operator is told ("your proxy is back"). If the
  // restore commands all no-op'd — wrong unit name, service refuses to start — the
  // box is dark, and saying it came back is worse than saying nothing.
  it("reports rolledBack=false when the proxy did NOT actually come back", async () => {
    const { executor } = makeExecutor({ portServedAfterRollback: false });
    h.installContainerEdge.mockResolvedValue({ component: "edge", success: false, error: "boom" });

    const res = await runEdgeTakeover(executor, { status: STATUS, sites: SITES }, noop);

    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(false);
  });

  // "I stopped its owner" is not ":80 is bindable" — something else may hold the
  // socket (a second nginx, a stray container, a lingering worker). Installing anyway
  // starts an edge that loses the race and crash-loops on
  // `bind() … (98: Address already in use)` while `docker run` exits 0, so this would
  // report a successful migration of a box serving nothing.
  it("refuses to install — and restores the proxy — when the ports never come free", async () => {
    h.freeEdgeTargets.mockImplementation(async () => ({ freed: false, stillBound: [80, 443] }));
    const { executor, cmds } = makeExecutor();

    const res = await runEdgeTakeover(executor, { status: STATUS, sites: SITES }, noop);

    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(res.warnings.some((w) => w.includes("80 and 443"))).toBe(true);
    expect(h.installContainerEdge).not.toHaveBeenCalled();
    expect(h.registerRoute).not.toHaveBeenCalled();
    expect(rolledBackNginx(cmds)).toBe(true);
  });

  it("rolls back when a post-install step throws (e.g. path detection)", async () => {
    h.installContainerEdge.mockResolvedValue({ success: true });
    h.detectPaths.mockRejectedValue(new Error("no openresty prefix"));
    const { executor, cmds } = makeExecutor();

    const res = await runEdgeTakeover(executor, { status: STATUS, sites: SITES }, noop);

    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(res.warnings.some((w) => w.includes("no openresty prefix"))).toBe(true);
    expect(rolledBackNginx(cmds)).toBe(true);
  });

  it("registers the migrated sites on the CONTAINER edge when that's what came up", async () => {
    // The provider has to match the edge we just installed. Building a bare-paths
    // provider against a container edge writes every migrated vhost to a directory
    // nothing serves from — and by this point the foreign proxy is already stopped,
    // so it reads as "migrated N sites" with the box actually dark.
    h.installContainerEdge.mockResolvedValue({ success: true });
    h.resolveOurEdgeContainer.mockResolvedValue("openship-edge");
    h.containerEdgeProvider.mockResolvedValue({
      registerRoute: h.registerRoute,
      provisionCert: h.provisionCert,
      installCert: h.installCert,
    });
    const { executor } = makeExecutor();

    const res = await runEdgeTakeover(executor, { status: STATUS, sites: SITES }, noop);

    expect(res.ok).toBe(true);
    expect(res.registered).toEqual(["app.example.com"]);
    expect(h.containerEdgeProvider).toHaveBeenCalledWith(
      executor,
      "openship-edge",
      expect.anything(),
    );
    // The bare path must NOT be consulted when a container edge is present.
    expect(h.detectPaths).not.toHaveBeenCalled();
  });

  it("a single route failure is tolerated (warns) — NOT a full rollback", async () => {
    h.installContainerEdge.mockResolvedValue({ success: true });
    h.registerRoute.mockRejectedValueOnce(new Error("route conflict"));
    const { executor, cmds } = makeExecutor();

    const res = await runEdgeTakeover(executor, { status: STATUS, sites: SITES }, noop);

    // install + infra were fine; one bad route doesn't tear down the migration.
    expect(res.rolledBack).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.includes("route conflict"))).toBe(true);
    expect(rolledBackNginx(cmds)).toBe(false);
  });
});
