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
  installOpenResty: vi.fn(),
  checkOpenResty: vi.fn(),
  detectPaths: vi.fn(),
  registerRoute: vi.fn(),
  provisionCert: vi.fn(),
  installCert: vi.fn(),
  freeEdgeTargets: vi.fn(async () => {}),
}));

vi.mock("../installer", () => ({ installOpenResty: h.installOpenResty }));
vi.mock("../checks", () => ({ checkOpenResty: h.checkOpenResty }));
vi.mock("../../infra/openresty-lua", () => ({ detectOpenRestyPaths: h.detectPaths }));
vi.mock("../../infra/nginx", () => ({
  NginxProvider: class {
    registerRoute = h.registerRoute;
    provisionCert = h.provisionCert;
    installCert = h.installCert;
  },
}));
vi.mock("./detect", () => ({
  freeEdgeTargets: h.freeEdgeTargets,
  stopTargetsForStatus: () => [],
  sq: (s: string) => `'${s}'`,
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

function makeExecutor() {
  const cmds: string[] = [];
  const executor = {
    exec: vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("is-enabled")) return "enabled"; // journal: foreign proxy was enabled
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
  h.freeEdgeTargets.mockImplementation(async () => {});
  h.detectPaths.mockResolvedValue({});
  h.registerRoute.mockResolvedValue(undefined);
  h.provisionCert.mockResolvedValue({ verified: true });
  h.checkOpenResty.mockResolvedValue({ healthy: true, message: "ok" });
});

describe("runEdgeTakeover", () => {
  it("happy path: registers sites, marks complete, does NOT roll back", async () => {
    h.installOpenResty.mockResolvedValue({ success: true });
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
    h.installOpenResty.mockResolvedValue({ success: false, error: "install boom" });
    const { executor, cmds } = makeExecutor();

    const res = await runEdgeTakeover(executor, { status: STATUS, sites: SITES }, noop);

    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(res.warnings).toContain("install boom");
    expect(rolledBackNginx(cmds)).toBe(true); // foreign proxy restored
    expect(h.registerRoute).not.toHaveBeenCalled();
  });

  it("rolls back when a post-install step throws (e.g. path detection)", async () => {
    h.installOpenResty.mockResolvedValue({ success: true });
    h.detectPaths.mockRejectedValue(new Error("no openresty prefix"));
    const { executor, cmds } = makeExecutor();

    const res = await runEdgeTakeover(executor, { status: STATUS, sites: SITES }, noop);

    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(res.warnings.some((w) => w.includes("no openresty prefix"))).toBe(true);
    expect(rolledBackNginx(cmds)).toBe(true);
  });

  it("a single route failure is tolerated (warns) — NOT a full rollback", async () => {
    h.installOpenResty.mockResolvedValue({ success: true });
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
