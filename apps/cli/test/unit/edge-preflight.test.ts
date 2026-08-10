import { describe, it, expect, vi } from "vitest";
import { planAndApplyHostEdge, type EdgePreflightDeps } from "../../src/lib/edge-preflight";

/** A blocked-edge EdgeStatus double (only `classification` is read by the code). */
function status(classification = "known") {
  return { classification, occupants: [{ command: "nginx", port: 80 }], canProceedClean: false } as any;
}

const tlsSite = {
  serverNames: ["a.com"],
  ssl: true,
  target: { kind: "proxy", url: "http://127.0.0.1:3000" },
  tls: { certPath: "/etc/ssl/a.crt", keyPath: "/etc/ssl/a.key" },
} as any;

/** Fully-faked deps; individual tests override what they assert on. */
function deps(over: Partial<EdgePreflightDeps> = {}): EdgePreflightDeps {
  return {
    platform: "linux",
    interactive: true,
    makeExecutor: () => ({}) as any,
    foreignProxyOnEdge: vi.fn(async () => ({ status: status(), blocked: true, owner: "nginx" })),
    importSites: vi.fn(async () => ({ sites: [tlsSite], warnings: [] })),
    beginEdgeTakeover: vi.fn(async () => ({ freed: true, stillBound: [] })),
    rollbackHostEdge: vi.fn(async () => true),
    recoverInterruptedTakeover: vi.fn(async () => {}),
    ourEdgeContainerRunning: vi.fn(async () => false),
    collectCerts: vi.fn(async () => ({ "a.com": { certPem: "CERT", keyPem: "KEY" } })),
    detectInstalledProxy: vi.fn(async () => null),
    scanProxySites: vi.fn(async () => ({ sites: [tlsSite], warnings: [] })),
    edgeServedHostnames: vi.fn(() => new Set<string>()),
    confirmStoppedImport: vi.fn(async () => true),
    render: vi.fn(),
    confirm: vi.fn(async () => "cancel"),
    warn: vi.fn(),
    ...over,
  };
}

describe("planAndApplyHostEdge", () => {
  it("skips entirely on non-Linux hosts", async () => {
    const d = deps({ platform: "darwin" });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan).toEqual({ proceed: true });
    expect(d.foreignProxyOnEdge).not.toHaveBeenCalled();
  });

  it("proceeds without prompting when the edge is free/ours", async () => {
    const d = deps({
      foreignProxyOnEdge: vi.fn(async () => ({ status: status("free"), blocked: false, owner: "" })),
    });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan).toEqual({ proceed: true });
    expect(d.importSites).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.beginEdgeTakeover).not.toHaveBeenCalled();
  });

  it("cancels (no take-over) when the user declines", async () => {
    const d = deps({ confirm: vi.fn(async () => "cancel") });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan).toEqual({ proceed: false });
    expect(d.beginEdgeTakeover).not.toHaveBeenCalled();
  });

  it("takeover stops the proxy and carries no sites", async () => {
    const d = deps({ confirm: vi.fn(async () => "takeover") });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan.proceed).toBe(true);
    expect(plan.action).toBe("takeover");
    expect(plan.sites).toBeUndefined();
    expect(d.beginEdgeTakeover).toHaveBeenCalledTimes(1);
  });

  it("migrate stops the proxy, returns sites, and harvests cert PEMs by hostname", async () => {
    const d = deps({ confirm: vi.fn(async () => "migrate") });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan.proceed).toBe(true);
    expect(plan.action).toBe("migrate");
    expect(plan.sites).toEqual([tlsSite]);
    expect(plan.certPems).toEqual({ "a.com": { certPem: "CERT", keyPem: "KEY" } });
    expect(d.beginEdgeTakeover).toHaveBeenCalledTimes(1);
  });

  // The certs must be read while the proxy is still UP: a containerized caddy or
  // traefik keeps its store inside the container, so once beginEdgeTakeover stops
  // it there is nothing left to read and every domain re-issues through ACME.
  it("harvests the certs BEFORE stopping the proxy", async () => {
    const order: string[] = [];
    const d = deps({
      confirm: vi.fn(async () => "migrate"),
      collectCerts: vi.fn(async () => {
        order.push("collect");
        return {};
      }),
      beginEdgeTakeover: vi.fn(async () => {
        order.push("stop");
        return { freed: true, stillBound: [] };
      }),
    });
    await planAndApplyHostEdge({}, d);
    expect(order).toEqual(["collect", "stop"]);
  });

  it("takeover harvests nothing (the occupant's sites are dropped, not carried)", async () => {
    const d = deps({ confirm: vi.fn(async () => "takeover") });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan.certPems).toBeUndefined();
    expect(d.collectCerts).not.toHaveBeenCalled();
  });

  it("stops the proxy through the JOURNALED path (so a failed bring-up can roll back)", async () => {
    const order: string[] = [];
    const d = deps({
      confirm: vi.fn(async () => "migrate"),
      beginEdgeTakeover: vi.fn(async () => {
        order.push("begin");
        return { freed: true, stillBound: [] };
      }),
      importSites: vi.fn(async () => {
        order.push("import");
        return { sites: [tlsSite], warnings: [] };
      }),
    });
    await planAndApplyHostEdge({}, d);
    // beginEdgeTakeover journals then frees — the CLI must never call the raw
    // freeEdgeTargets, or a failed compose up leaves 80/443 dark with no record.
    expect(order).toEqual(["import", "begin"]);
  });

  // A stop that doesn't release the socket is the difference between "we took over"
  // and "the edge will crash-loop on bind()". Proceeding here is what made every
  // surface report success for a box that served nothing.
  it("refuses to proceed — and hands the proxy back — when the ports never come free", async () => {
    const d = deps({
      confirm: vi.fn(async () => "takeover"),
      beginEdgeTakeover: vi.fn(async () => ({ freed: false, stillBound: [80, 443] })),
    });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan.proceed).toBe(false);
    expect(plan.blockedBy).toContain("80 and 443");
    expect(d.rollbackHostEdge).toHaveBeenCalledTimes(1);
  });

  it("restores an interrupted takeover BEFORE probing, and reports our edge health", async () => {
    const calls: string[] = [];
    const d = deps({
      recoverInterruptedTakeover: vi.fn(async (_e, _l, isEdgeHealthy) => {
        calls.push("recover");
        await isEdgeHealthy?.();
      }),
      ourEdgeContainerRunning: vi.fn(async () => {
        calls.push("edge-health");
        return false;
      }),
      foreignProxyOnEdge: vi.fn(async () => {
        calls.push("probe");
        return { status: status("free"), blocked: false, owner: "" };
      }),
    });
    await planAndApplyHostEdge({}, d);
    expect(calls).toEqual(["recover", "edge-health", "probe"]);
  });

  it("honors the --edge flag without prompting", async () => {
    const d = deps({ confirm: vi.fn() });
    const plan = await planAndApplyHostEdge({ edge: "cancel" }, d);
    expect(plan).toEqual({ proceed: false });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("defaults to cancel in a non-interactive run with no flag", async () => {
    const d = deps({ interactive: false, confirm: vi.fn() });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan).toEqual({ proceed: false });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.warn).toHaveBeenCalled();
  });
});

describe("planAndApplyHostEdge — stopped proxy with unimported sites", () => {
  /** Ports free/ours, but an installed-yet-stopped nginx still has vhosts on disk. */
  function stoppedDeps(over: Partial<EdgePreflightDeps> = {}) {
    return deps({
      foreignProxyOnEdge: vi.fn(async () => ({ status: status("free"), blocked: false, owner: "" })),
      detectInstalledProxy: vi.fn(async () => "nginx" as const),
      ...over,
    });
  }

  it("does NOT re-offer sites the edge already serves", async () => {
    // The regression: after a successful migration, re-running `up` asked to import
    // the same sites again. The old signal was a marker file under OS_DIR, which
    // `openship-dev` (OPENSHIP_HOME=~/.openship-dev) can't see and a wiped
    // ~/.openship loses — so the tool appeared to forget what it had just done.
    const d = stoppedDeps({ edgeServedHostnames: vi.fn(() => new Set(["a.com"])) });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan).toEqual({ proceed: true });
    expect(d.render).not.toHaveBeenCalled(); // never prompted
  });

  it("offers only what is genuinely unserved", async () => {
    const twoSites = [tlsSite, { ...tlsSite, serverNames: ["b.com"] }];
    const d = stoppedDeps({
      scanProxySites: vi.fn(async () => ({ sites: twoSites, warnings: [] })),
      edgeServedHostnames: vi.fn(() => new Set(["a.com"])),
      render: vi.fn(),
    });
    await planAndApplyHostEdge({}, d);
    // a.com is live; only b.com should be presented.
    const rendered = (d.render as any).mock.calls[0][0];
    expect(rendered.sites).toHaveLength(1);
    expect(rendered.sites[0].serverNames).toEqual(["b.com"]);
  });

  it("treats a multi-hostname site as done only when EVERY hostname is served", async () => {
    const multi = [{ ...tlsSite, serverNames: ["onvo.me", "www.onvo.me"] }];
    const d = stoppedDeps({
      scanProxySites: vi.fn(async () => ({ sites: multi, warnings: [] })),
      // apex served, www not → still needs importing
      edgeServedHostnames: vi.fn(() => new Set(["onvo.me"])),
      render: vi.fn(),
    });
    await planAndApplyHostEdge({}, d);
    expect(d.render).toHaveBeenCalled();
  });

  it("stays quiet when no proxy is installed", async () => {
    const d = stoppedDeps({ detectInstalledProxy: vi.fn(async () => null) });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan).toEqual({ proceed: true });
    expect(d.scanProxySites).not.toHaveBeenCalled();
  });

  it("never stops anything — there is nothing holding the ports", async () => {
    const d = stoppedDeps({ edgeServedHostnames: vi.fn(() => new Set(["a.com"])) });
    await planAndApplyHostEdge({}, d);
    expect(d.beginEdgeTakeover).not.toHaveBeenCalled();
  });
});
