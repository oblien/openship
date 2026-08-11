import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ImportedSite } from "@repo/adapters";
import type { Project } from "@repo/db";

/**
 * The read-back endpoint exists because "saved equals served" was an assumption. It
 * only helps if its verdict is trustworthy in both directions:
 *
 *  - **False drift is worse than no badge.** A permanent "the edge is serving
 *    something else" on a correctly-applied config trains the operator to ignore it.
 *    The two ways to manufacture it are companion directives (`gzip: true` renders
 *    `gzip_types`/`gzip_vary`/`gzip_min_length` too) and the `http2` version floor
 *    (deliberately skipped below nginx 1.25.1) — so both are pinned here.
 *  - **Silence about a value the box IS serving.** A hand-written vhost can hold
 *    `proxy_read_timeout 1d`, which our validators reject; reporting "not set" for it
 *    would be the one lie this endpoint must not tell.
 *
 * The box is faked at the executor seam: these assert the report, not SSH.
 */

const { listDomains, withServerHostExecutor, edgeProxy, detectOpenRestyPaths } = vi.hoisted(() => ({
  listDomains: vi.fn(),
  withServerHostExecutor: vi.fn(),
  edgeProxy: vi.fn(),
  detectOpenRestyPaths: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/db")>()),
  repos: { domain: { listByProject: listDomains } },
}));

vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/adapters")>()),
  edgeProxy,
  detectOpenRestyPaths,
}));

vi.mock("../../../src/lib/edge-host-executor", () => ({ withServerHostExecutor }));

import { readProjectEdgeConfig } from "../../../src/modules/projects/edge-config.service";

const project = (over: Partial<Project> = {}) =>
  ({ id: "p1", slug: "app", routingConfig: null, ...over }) as Project;

/** A live vhost as the nginx parser would hand it back. */
const site = (over: Partial<ImportedSite> = {}): ImportedSite =>
  ({
    serverNames: ["app.example.com"],
    ssl: true,
    target: { kind: "proxy", url: "http://127.0.0.1:3000" },
    ...over,
  }) as ImportedSite;

/**
 * Wire the faked box: `siteFor` answers per hostname, `nginxVersion` feeds the
 * version floor. `null` site = no vhost found for that host.
 */
function box(opts: {
  sites?: Record<string, ImportedSite | null>;
  kind?: string;
  ours?: boolean;
  version?: readonly [number, number, number] | null;
}) {
  edgeProxy.mockResolvedValue({
    kind: opts.kind ?? "openresty",
    ours: opts.ours ?? true,
    siteFor: vi.fn(async (h: string) => opts.sites?.[h] ?? null),
  });
  detectOpenRestyPaths.mockResolvedValue({ nginxVersion: opts.version ?? null });
  withServerHostExecutor.mockImplementation(
    async (_p: Project, fn: (e: unknown) => Promise<unknown>) => fn({}),
  );
}

const byKey = (report: Awaited<ReturnType<typeof readProjectEdgeConfig>>, key: string) =>
  report.hosts[0]?.directives.find((d) => d.key === key);

beforeEach(() => {
  vi.clearAllMocks();
  listDomains.mockResolvedValue([{ id: "d1", hostname: "app.example.com" }]);
});

describe("readProjectEdgeConfig — when it can't tell", () => {
  it("reports unreachable for a cloud project without touching a box", async () => {
    const r = await readProjectEdgeConfig(project({ cloudWorkspaceId: "ws1" }));
    expect(r).toEqual({ reachable: false, saved: {}, hosts: [] });
    expect(withServerHostExecutor).not.toHaveBeenCalled();
  });

  it("reports unreachable for a project with no hostnames yet", async () => {
    listDomains.mockResolvedValue([]);
    const r = await readProjectEdgeConfig(project({ routingConfig: { proxy: { gzip: true } } }));
    expect(r.reachable).toBe(false);
    // The saved value still comes back — the form binds to it.
    expect(r.saved).toEqual({ gzip: true });
  });

  it("reports unreachable rather than throwing when the box can't be reached", async () => {
    withServerHostExecutor.mockRejectedValue(new Error("ssh: connection refused"));
    await expect(readProjectEdgeConfig(project())).resolves.toMatchObject({ reachable: false });
  });

  it("reports unreachable when nothing proxy-like answers", async () => {
    edgeProxy.mockResolvedValue(null);
    withServerHostExecutor.mockImplementation(
      async (_p: Project, fn: (e: unknown) => Promise<unknown>) => fn({}),
    );
    expect((await readProjectEdgeConfig(project())).reachable).toBe(false);
  });

  it("claims no drift for a hostname that has no vhost on the box", async () => {
    // A project that saved a limit but hasn't deployed yet: "we can't tell" is not
    // "the box disagrees".
    box({ sites: { "app.example.com": null } });
    const r = await readProjectEdgeConfig(
      project({ routingConfig: { proxy: { clientMaxBodySize: "50m" } } }),
    );
    expect(r.hosts[0]!.found).toBe(false);
    expect(r.hosts[0]!.driftCount).toBe(0);
    expect(byKey(r, "clientMaxBodySize")).toMatchObject({ expected: "50m", drift: false });
    expect(r.hosts[0]!.adoptable).toEqual({});
  });
});

describe("readProjectEdgeConfig — agreement", () => {
  it("reports no drift when the live vhost matches what was saved", async () => {
    box({
      sites: {
        "app.example.com": site({ proxy: { clientMaxBodySize: "50m", proxyReadTimeout: "300s" } }),
      },
    });
    const r = await readProjectEdgeConfig(
      project({ routingConfig: { proxy: { clientMaxBodySize: "50m", proxyReadTimeout: "300s" } } }),
    );
    expect(r.reachable).toBe(true);
    expect(r.hosts[0]!.driftCount).toBe(0);
    expect(r.hosts[0]!.adoptable).toEqual({});
  });

  it("does not invent drift for gzip's companion directives", async () => {
    // `gzip: true` renders gzip_min_length 1024 as well. Comparing the saved object
    // (which has no such key) against the live vhost would flag it forever.
    box({ sites: { "app.example.com": site({ proxy: { gzip: true, gzipMinLength: 1024 } }) } });
    const r = await readProjectEdgeConfig(project({ routingConfig: { proxy: { gzip: true } } }));
    expect(r.hosts[0]!.driftCount).toBe(0);
    expect(byKey(r, "gzipMinLength")).toMatchObject({ expected: 1024, live: 1024, drift: false });
  });

  it("shows only directives one side actually has", async () => {
    box({ sites: { "app.example.com": site({ proxy: { clientMaxBodySize: "50m" } }) } });
    const r = await readProjectEdgeConfig(
      project({ routingConfig: { proxy: { clientMaxBodySize: "50m" } } }),
    );
    expect(r.hosts[0]!.directives.map((d) => d.key)).toEqual(["clientMaxBodySize"]);
  });

  it("passes the box's nginx version through, since the floor depends on it", async () => {
    box({ sites: { "app.example.com": site() }, version: [1, 27, 1] });
    expect((await readProjectEdgeConfig(project())).nginxVersion).toBe("1.27.1");
  });

  it("does not ask a foreign proxy for an openresty version", async () => {
    box({ sites: { "app.example.com": site() }, kind: "nginx", ours: false });
    const r = await readProjectEdgeConfig(project());
    expect(detectOpenRestyPaths).not.toHaveBeenCalled();
    expect(r).toMatchObject({ reachable: true, proxyKind: "nginx", ours: false });
    expect(r.nginxVersion).toBeUndefined();
  });
});

describe("readProjectEdgeConfig — drift", () => {
  it("flags a hand-edited value and offers it for adoption", async () => {
    // The parser reports both for a value it can parse: `live` (adoptable) and
    // `liveRaw` (what the file literally says).
    box({
      sites: {
        "app.example.com": site({
          proxy: { clientMaxBodySize: "1m" },
          proxyRaw: { clientMaxBodySize: "1m" },
        }),
      },
    });
    const r = await readProjectEdgeConfig(
      project({ routingConfig: { proxy: { clientMaxBodySize: "50m" } } }),
    );
    expect(byKey(r, "clientMaxBodySize")).toMatchObject({
      expected: "50m",
      live: "1m",
      liveRaw: "1m",
      drift: true,
    });
    expect(r.hosts[0]!.adoptable).toEqual({ clientMaxBodySize: "1m" });
    expect(r.hosts[0]!.driftCount).toBe(1);
  });

  it("flags a directive the box serves that the project never saved", async () => {
    box({ sites: { "app.example.com": site({ proxy: { serverTokens: false } }) } });
    const r = await readProjectEdgeConfig(project());
    expect(byKey(r, "serverTokens")).toMatchObject({ live: false, drift: true });
    expect(r.hosts[0]!.adoptable).toEqual({ serverTokens: false });
  });

  it("flags a saved directive the box is NOT serving (a lost reload)", async () => {
    box({ sites: { "app.example.com": site({ proxy: {} }) } });
    const r = await readProjectEdgeConfig(
      project({ routingConfig: { proxy: { clientMaxBodySize: "50m" } } }),
    );
    expect(byKey(r, "clientMaxBodySize")).toMatchObject({ expected: "50m", drift: true });
    // Nothing to adopt: there is no live value to take.
    expect(r.hosts[0]!.adoptable).toEqual({});
  });

  it("reports a live value our own validators reject, and refuses to adopt it", async () => {
    box({
      sites: {
        "app.example.com": site({ proxy: {}, proxyRaw: { proxyReadTimeout: "1d" } }),
      },
    });
    const r = await readProjectEdgeConfig(project());
    expect(byKey(r, "proxyReadTimeout")).toMatchObject({ liveRaw: "1d", drift: true });
    expect(byKey(r, "proxyReadTimeout")!.live).toBeUndefined();
    expect(r.hosts[0]!.adoptable).toEqual({});
  });

  it("sanitizes the adopt payload, so adopting can't store something unrenderable", async () => {
    // Belt and braces: the parser already validated, but `adoptable` is handed
    // straight back to a PUT.
    box({
      sites: {
        "app.example.com": site({
          proxy: { clientMaxBodySize: "20m", gzipCompLevel: 9 },
        }),
      },
    });
    const r = await readProjectEdgeConfig(project());
    expect(r.hosts[0]!.adoptable).toEqual({ clientMaxBodySize: "20m", gzipCompLevel: 9 });
  });
});

describe("readProjectEdgeConfig — the http2 version floor", () => {
  const saved = { routingConfig: { proxy: { http2: true } } } as Partial<Project>;

  it("expects nothing on a box below 1.25.1, so an old box shows no drift", async () => {
    // `http2 on;` at server scope doesn't exist before 1.25.1; the renderer skips it.
    box({ sites: { "app.example.com": site({ proxy: {} }) }, version: [1, 24, 0] });
    const r = await readProjectEdgeConfig(project(saved));
    expect(byKey(r, "http2")).toBeUndefined();
    expect(r.hosts[0]!.driftCount).toBe(0);
  });

  it("expects it on a box that supports it, and flags its absence", async () => {
    box({ sites: { "app.example.com": site({ proxy: {} }) }, version: [1, 27, 1] });
    const r = await readProjectEdgeConfig(project(saved));
    expect(byKey(r, "http2")).toMatchObject({ expected: true, drift: true });
  });

  it("expects it when the version is unknown (default-allow, like the renderer)", async () => {
    box({ sites: { "app.example.com": site({ proxy: { http2: true } }) }, version: null });
    const r = await readProjectEdgeConfig(project(saved));
    expect(byKey(r, "http2")).toMatchObject({ expected: true, live: true, drift: false });
  });

  it("expects nothing on a plaintext vhost (h2c is not what anyone asked for)", async () => {
    box({ sites: { "app.example.com": site({ ssl: false, proxy: {} }) }, version: [1, 27, 1] });
    const r = await readProjectEdgeConfig(project(saved));
    expect(r.hosts[0]!.tls).toBe(false);
    expect(byKey(r, "http2")).toBeUndefined();
  });
});

describe("readProjectEdgeConfig — hostnames", () => {
  it("reports every hostname of the project, deduped, lowercased and sorted", async () => {
    listDomains.mockResolvedValue([
      { id: "d1", hostname: "B.example.com" },
      { id: "d2", hostname: "a.example.com" },
      { id: "d3", hostname: "b.example.com" }, // same host, different row
    ]);
    box({ sites: {} });
    const r = await readProjectEdgeConfig(project());
    expect(r.hosts.map((h) => h.hostname)).toEqual(["a.example.com", "b.example.com"]);
  });

  it("keeps per-host verdicts separate", async () => {
    listDomains.mockResolvedValue([
      { id: "d1", hostname: "a.example.com" },
      { id: "d2", hostname: "b.example.com" },
    ]);
    box({
      sites: {
        "a.example.com": site({ serverNames: ["a.example.com"], proxy: { clientMaxBodySize: "50m" } }),
        "b.example.com": site({ serverNames: ["b.example.com"], proxy: { clientMaxBodySize: "1m" } }),
      },
    });
    const r = await readProjectEdgeConfig(
      project({ routingConfig: { proxy: { clientMaxBodySize: "50m" } } }),
    );
    expect(r.hosts.map((h) => h.driftCount)).toEqual([0, 1]);
    expect(r.hosts[1]!.adoptable).toEqual({ clientMaxBodySize: "1m" });
  });

  it("survives one hostname failing to read", async () => {
    listDomains.mockResolvedValue([
      { id: "d1", hostname: "a.example.com" },
      { id: "d2", hostname: "b.example.com" },
    ]);
    edgeProxy.mockResolvedValue({
      kind: "openresty",
      ours: true,
      siteFor: vi.fn(async (h: string) => {
        if (h === "a.example.com") throw new Error("parse blew up");
        return site({ serverNames: [h], proxy: { clientMaxBodySize: "50m" } });
      }),
    });
    detectOpenRestyPaths.mockResolvedValue({ nginxVersion: null });
    withServerHostExecutor.mockImplementation(
      async (_p: Project, fn: (e: unknown) => Promise<unknown>) => fn({}),
    );

    const r = await readProjectEdgeConfig(project());
    expect(r.reachable).toBe(true);
    expect(r.hosts.map((h) => h.found)).toEqual([false, true]);
  });
});
