import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The edge-orphan sweep's I/O half.
 *
 * The assertions that matter are the REFUSALS. `removeEdgeOrphan` stops serving a
 * hostname, so without its re-scan guard the endpoint would be "delete any vhost
 * by name" — and a dashboard list left open while someone claimed that domain
 * would take a live site down on the next click.
 *
 * The other half is false positives: mail routes and the managed-edge dashboard
 * vhost have no `domain` row, so a sweep that only consulted domains would report
 * live infrastructure as forgotten on every scan.
 */

const h = vi.hoisted(() => ({
  hostnames: [] as string[],
  mailServers: [] as Array<{ domain: string }>,
  sites: [] as Array<{
    serverNames: string[];
    ssl: boolean;
    target: { kind: "proxy"; url: string } | { kind: "static"; root: string };
  }>,
  ours: true,
  edgePresent: true,
  removeRoute: vi.fn(async (_h: string) => {}),
  publicUrl: undefined as string | undefined,
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: { listAllHostnames: async () => h.hostnames },
    mailServer: { list: async () => h.mailServers },
  },
}));

vi.mock("@repo/adapters", () => ({
  createExecutor: () => ({}),
  edgeProxy: async () =>
    h.edgePresent
      ? {
          kind: h.ours ? "openresty" : "caddy",
          ours: h.ours,
          container: null,
          listSites: async () => ({ proxy: "openresty", sites: h.sites, warnings: [] }),
          siteFor: async (host: string) =>
            h.sites.find((s) => s.serverNames.some((n) => n.toLowerCase() === host)) ?? null,
        }
      : null,
}));

vi.mock("../../src/lib/controller-helpers", () => ({
  platform: () => ({ routing: { removeRoute: h.removeRoute } }),
}));

vi.mock("../../src/config/env", () => ({
  get env() {
    return { OPENSHIP_PUBLIC_URL: h.publicUrl };
  },
}));

import {
  collectKnownHostnames,
  removeEdgeOrphan,
  scanEdgeOrphans,
  untrackedSiteFor,
} from "../../src/lib/edge-orphans.service";

const staticSite = (host: string) => ({
  serverNames: [host],
  ssl: true,
  target: { kind: "static" as const, root: "/opt/openship/static/releases/dep_old" },
});
const proxySite = (host: string) => ({
  serverNames: [host],
  ssl: true,
  target: { kind: "proxy" as const, url: "http://127.0.0.1:3000" },
});

beforeEach(() => {
  h.hostnames = [];
  h.mailServers = [];
  h.sites = [];
  h.ours = true;
  h.edgePresent = true;
  h.publicUrl = undefined;
  h.removeRoute.mockClear();
});

describe("collectKnownHostnames", () => {
  it("includes mail-server route hostnames, which have no domain row", async () => {
    h.mailServers = [{ domain: "example.com" }];
    const known = await collectKnownHostnames();
    expect(known).toContain("mail.example.com");
    expect(known).toContain("api.mail.example.com");
    expect(known).toContain("autodiscover.example.com");
  });

  it("includes the managed-edge dashboard hostname from OPENSHIP_PUBLIC_URL", async () => {
    h.publicUrl = "https://panel.example.com:8443";
    expect(await collectKnownHostnames()).toContain("panel.example.com");
  });

  it("survives a junk OPENSHIP_PUBLIC_URL instead of throwing mid-sweep", async () => {
    h.publicUrl = "not a url";
    await expect(collectKnownHostnames()).resolves.toBeInstanceOf(Array);
  });
});

describe("scanEdgeOrphans", () => {
  it("reports a forgotten static vhost", async () => {
    h.hostnames = ["live.example.com"];
    h.sites = [proxySite("live.example.com"), staticSite("forgotten.example.com")];
    const scan = await scanEdgeOrphans();
    expect(scan.scanned).toBe(true);
    expect(scan.orphans.map((o) => o.hostname)).toEqual(["forgotten.example.com"]);
    expect(scan.orphans[0]!.kind).toBe("static");
  });

  it("does not flag mail routes as forgotten", async () => {
    h.mailServers = [{ domain: "example.com" }];
    h.sites = [proxySite("mail.example.com"), proxySite("api.mail.example.com")];
    const scan = await scanEdgeOrphans();
    expect(scan.orphans).toEqual([]);
  });

  /**
   * `scanned: false` is NOT `orphans: []`. A caller that conflated them would
   * render "all clear" for a box it never managed to read.
   */
  it("reports not-scanned (with a reason) when there is no edge", async () => {
    h.edgePresent = false;
    const scan = await scanEdgeOrphans();
    expect(scan.scanned).toBe(false);
    expect(scan.reason).toBeTruthy();
    expect(scan.orphans).toEqual([]);
  });

  it("refuses to judge a FOREIGN proxy's vhosts", async () => {
    h.ours = false;
    h.sites = [staticSite("someone-elses-site.example.com")];
    const scan = await scanEdgeOrphans();
    expect(scan.scanned).toBe(false);
    expect(scan.orphans).toEqual([]);
  });
});

describe("untrackedSiteFor (the domain-claim warning)", () => {
  it("returns the site when the edge already serves an untracked hostname", async () => {
    h.sites = [staticSite("reused.example.com")];
    const found = await untrackedSiteFor("reused.example.com");
    expect(found?.kind).toBe("static");
  });

  it("returns null once the hostname is tracked", async () => {
    h.hostnames = ["reused.example.com"];
    h.sites = [staticSite("reused.example.com")];
    expect(await untrackedSiteFor("reused.example.com")).toBeNull();
  });

  it("returns null when nothing is serving it", async () => {
    expect(await untrackedSiteFor("brand-new.example.com")).toBeNull();
  });

  it("never throws — a claim must not fail because the edge was unreadable", async () => {
    h.edgePresent = false;
    await expect(untrackedSiteFor("x.example.com")).resolves.toBeNull();
  });
});

describe("removeEdgeOrphan", () => {
  it("removes a hostname that is genuinely untracked", async () => {
    h.sites = [staticSite("forgotten.example.com")];
    const res = await removeEdgeOrphan("forgotten.example.com");
    expect(res.removed).toBe(true);
    expect(h.removeRoute).toHaveBeenCalledWith("forgotten.example.com");
  });

  /**
   * THE guard. A hostname that has since been claimed is no longer an orphan, so a
   * stale dashboard list must not be able to remove it.
   */
  it("REFUSES a hostname that is tracked, without touching the edge", async () => {
    h.hostnames = ["live.example.com"];
    h.sites = [proxySite("live.example.com")];
    const res = await removeEdgeOrphan("live.example.com");
    expect(res.removed).toBe(false);
    expect(res.reason).toContain("not an untracked vhost");
    expect(h.removeRoute).not.toHaveBeenCalled();
  });

  it("REFUSES a hostname the edge doesn't serve at all", async () => {
    const res = await removeEdgeOrphan("nowhere.example.com");
    expect(res.removed).toBe(false);
    expect(h.removeRoute).not.toHaveBeenCalled();
  });

  it("REFUSES when the edge is foreign, so it can't be used to edit someone else's proxy", async () => {
    h.ours = false;
    h.sites = [staticSite("forgotten.example.com")];
    const res = await removeEdgeOrphan("forgotten.example.com");
    expect(res.removed).toBe(false);
    expect(h.removeRoute).not.toHaveBeenCalled();
  });

  it("matches an alias on the vhost, not just the primary name", async () => {
    h.sites = [
      { ...staticSite("old.example.com"), serverNames: ["old.example.com", "www.old.example.com"] },
    ];
    const res = await removeEdgeOrphan("www.old.example.com");
    expect(res.removed).toBe(true);
    // Removal is keyed on the vhost's PRIMARY name — that's the conf file.
    expect(h.removeRoute).toHaveBeenCalledWith("old.example.com");
  });

  it("surfaces a routing failure instead of claiming success", async () => {
    h.sites = [staticSite("forgotten.example.com")];
    h.removeRoute.mockRejectedValueOnce(new Error("reload failed"));
    const res = await removeEdgeOrphan("forgotten.example.com");
    expect(res.removed).toBe(false);
    expect(res.reason).toContain("reload failed");
  });

  it("rejects an empty hostname", async () => {
    expect((await removeEdgeOrphan("   ")).removed).toBe(false);
  });
});
