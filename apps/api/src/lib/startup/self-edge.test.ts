import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Halt-and-report contract for the non-interactive self-install edge step.
 *
 * When a foreign proxy already holds 80/443 and no takeover was pre-authorized,
 * ensureSelfEdgeInfra must NOT install (never blind-kill someone's proxy) and must
 * RESOLVE `{ ok:false, reason:"edge_conflict" }` — not throw, not fall through to a
 * bare cert failure downstream. With a clear edge, it installs as normal.
 *
 * @repo/adapters is mocked so this runs with no real box; process.platform/getuid
 * are stubbed to satisfy the Linux+root guard that gates the whole path.
 */

const h = vi.hoisted(() => ({
  canProceedClean: false,
  sites: [{}, {}] as unknown[],
  ensureFeature: vi.fn(async () => {}),
  foreignProxyOnEdge: vi.fn(),
  importSites: vi.fn(),
}));

vi.mock("@repo/adapters", () => ({
  createExecutor: () => ({}),
  SystemManager: class {
    ensureFeature = h.ensureFeature;
  },
  foreignProxyOnEdge: h.foreignProxyOnEdge,
  importSites: h.importSites,
  runEdgeTakeover: vi.fn(),
}));

import { ensureSelfEdgeInfra } from "./self-edge";

const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const origGetuid = process.getuid;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  // stub root so the not-root guard passes
  process.getuid = () => 0;
  h.canProceedClean = false;
  h.foreignProxyOnEdge.mockImplementation(async () => {
    const occupants = h.canProceedClean ? [] : [{ port: 80, command: "nginx", proxy: "nginx" }];
    return {
      status: {
        classification: h.canProceedClean ? "free" : "known",
        canProceedClean: h.canProceedClean,
        occupants,
      },
      blocked: !h.canProceedClean && occupants.length > 0,
      owner: occupants.map((o) => o.command).join(", "),
    };
  });
  h.importSites.mockImplementation(async () => ({ proxy: "nginx", sites: h.sites, warnings: [] }));
});

afterEach(() => {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
  process.getuid = origGetuid;
});

describe("ensureSelfEdgeInfra — halt + report", () => {
  it("occupied edge, no consent → { ok:false, reason:'edge_conflict' } and does NOT install", async () => {
    const res = await ensureSelfEdgeInfra();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("edge_conflict");
    expect(res.siteCount).toBe(2);
    expect(res.occupants).toContain("nginx");
    expect(h.ensureFeature).not.toHaveBeenCalled(); // never touched the box
  });

  it("free edge → installs ssl (openresty + certbot) and returns ok", async () => {
    h.canProceedClean = true;
    const res = await ensureSelfEdgeInfra();
    expect(res.ok).toBe(true);
    expect(h.ensureFeature).toHaveBeenCalledWith("ssl", expect.any(Function));
  });

  it("occupied edge WITH pre-authorized takeover → skips the guard and installs", async () => {
    const res = await ensureSelfEdgeInfra(undefined, { edgeTakeover: true });
    expect(res.ok).toBe(true);
    expect(h.foreignProxyOnEdge).not.toHaveBeenCalled(); // guard skipped when takeover is authorized
    expect(h.ensureFeature).toHaveBeenCalledWith("ssl", expect.any(Function));
  });
});
