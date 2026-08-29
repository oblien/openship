import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { EnvironmentProfile } from "@repo/adapters";

/**
 * Halt-and-report contract for the non-interactive self-install edge step.
 *
 * When a foreign proxy already holds 80/443 and no takeover was pre-authorized,
 * ensureSelfEdgeInfra must NOT install (never blind-kill someone's proxy) and must
 * RESOLVE `{ ok:false, reason:"edge_conflict" }` — not throw, not fall through to a
 * bare cert failure downstream. With a clear edge, it installs as normal.
 *
 * @repo/adapters is mocked so this runs with no real box; process.platform is stubbed
 * and the mocked resolver returns a root Ubuntu profile, which together satisfy the
 * Linux + can-elevate + supported-family guard that gates the whole path.
 */

const h = vi.hoisted(() => ({
  canProceedClean: false,
  sites: [{}, {}] as unknown[],
  /** What the resolver reports for this box; per-case overrides on the base fixture. */
  host: {} as Partial<EnvironmentProfile>,
  ensureFeature: vi.fn(async () => {}),
  foreignProxyOnEdge: vi.fn(),
  importSites: vi.fn(),
  runEdgeTakeover: vi.fn(),
}));

vi.mock("@repo/adapters", async () => {
  // The real fixture, not a hand-rolled literal: `resolveEnvironment` gates the whole
  // path on isRoot/canSudo/supported, and a literal here would keep passing after the
  // profile grows a field the product starts gating on. `profileFixture` also recomputes
  // the support verdict from the facts, so `distroFamily: "suse"` below carries openSUSE's
  // real reason rather than one this test invented.
  const fixtures = await import("../../../../../packages/adapters/src/system/environment.fixtures");
  return {
    createExecutor: () => ({}),
    resolveEnvironment: async () => fixtures.profileFixture(h.host),
    SystemManager: class {
      ensureFeature = h.ensureFeature;
    },
    foreignProxyOnEdge: h.foreignProxyOnEdge,
    importSites: h.importSites,
    runEdgeTakeover: h.runEdgeTakeover,
  };
});

// The build-only APPLY (build the edge from source onto the local daemon before
// bring-up) has its own unit tests — here it's a no-op so these cases stay about
// the halt-and-report contract, not the deliver pipeline.
vi.mock("../deliver-managed-image", () => ({
  deliverManagedImage: vi.fn(async () => ({ delivered: false })),
}));

import { ensureSelfEdgeInfra } from "./self-edge";

const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  // No `process.getuid` stub: privilege comes from the resolver now, so root-ness is a
  // property of `h.host` (the base fixture is a root box).
  h.host = {};
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

describe("ensureSelfEdgeInfra — a failed migrate reports WHY", () => {
  /** The takeover's own words for a refused, unelevated stop — the #490/#509 shape. */
  const refusal =
    "The port 80 is still in use, so the edge can't bind — nothing was installed. " +
    "Openship could not run the stop as root on this host, so stopping the existing " +
    "proxy was almost certainly refused — retrying as this user will fail the same way.";

  it("relays the takeover's classified warnings to the operator log and the result", async () => {
    h.runEdgeTakeover.mockResolvedValue({
      ok: false,
      rolledBack: true,
      registered: [],
      warnings: [refusal],
    });
    const logs: { message: string; level?: string }[] = [];
    const res = await ensureSelfEdgeInfra(
      { onLog: (message, level) => logs.push({ message, level }) },
      { edgeMigrate: true },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("migrate_failed");
    // The CAUSE, not just the fact: "migrate_failed" alone sends the operator to retry
    // an operation that can never succeed as this user.
    expect(res.detail).toContain("could not run the stop as root");
    expect(logs).toContainEqual({ message: refusal, level: "error" });
  });

  it("a migrate that SUCCEEDS with warnings still surfaces them (as warnings)", async () => {
    h.runEdgeTakeover.mockResolvedValue({
      ok: true,
      rolledBack: false,
      registered: ["a.example.com"],
      warnings: ["a.example.com: existing cert unreadable — issuing a fresh certificate"],
    });
    const logs: { message: string; level?: string }[] = [];
    const res = await ensureSelfEdgeInfra(
      { onLog: (message, level) => logs.push({ message, level }) },
      { edgeMigrate: true },
    );
    expect(res.ok).toBe(true);
    expect(res.detail).toBeUndefined();
    expect(logs.some((l) => l.level === "warn" && l.message.includes("existing cert unreadable"))).toBe(true);
  });
});

describe("ensureSelfEdgeInfra — the host gate reads the resolver", () => {
  it("non-root WITH passwordless sudo → installs (the installer elevates)", async () => {
    // The regression this pins: a bare `getuid() !== 0` refused this box, even though
    // `prepareExecutor` would have wrapped the executor in `elevatedExecutor`.
    h.canProceedClean = true;
    h.host = { isRoot: false, canSudo: true, loginUser: "ubuntu", home: "/home/ubuntu" };
    const res = await ensureSelfEdgeInfra();
    expect(res.ok).toBe(true);
    expect(h.ensureFeature).toHaveBeenCalledWith("ssl", expect.any(Function));
  });

  it("non-root with NO sudo → { reason:'not_root' } and never touches the box", async () => {
    h.canProceedClean = true;
    h.host = { isRoot: false, canSudo: false, loginUser: "deploy", home: "/home/deploy" };
    const res = await ensureSelfEdgeInfra();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not_root");
    expect(h.ensureFeature).not.toHaveBeenCalled();
  });

  it("unsupported family → { reason:'unsupported_host' } and never touches the box", async () => {
    h.canProceedClean = true;
    h.host = { distro: "opensuse", distroFamily: "suse", distroId: "opensuse-leap" };
    const res = await ensureSelfEdgeInfra();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unsupported_host");
    // The resolver's verdict, not just the code: which distro was observed is the
    // whole reason this box was refused.
    expect(res.detail).toContain("openSUSE");
    expect(h.ensureFeature).not.toHaveBeenCalled();
  });
});
