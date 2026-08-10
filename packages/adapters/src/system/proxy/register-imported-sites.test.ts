import { describe, it, expect, vi } from "vitest";
import { registerImportedSites } from "./takeover";
import { makeTestCert } from "./test-certs";
import type { CommandExecutor, RouteConfig, SslResult } from "../../types";
import type { ImportedSite } from "../types";
import type { RoutingProvider, SslProvider } from "../../infra/types";

const OK: SslResult = { domain: "", expiresAt: "", issuer: "", verified: true };

/** Minimal provider doubles capturing the calls registerImportedSites makes. */
function providers() {
  // Parameters are declared so `mock.calls[n][0]` is TYPED as the route — an
  // arg-less `vi.fn()` records each call as an empty tuple, and indexing it is a
  // compile error (the assertion below reads the captured route directly).
  const routing = {
    registerRoute: vi.fn(async (_route: RouteConfig) => {}),
    removeRoute: vi.fn(async (_domain: string) => {}),
  };
  const ssl = {
    provisionCert: vi.fn(async (): Promise<SslResult> => OK),
    installCert: vi.fn(async (): Promise<SslResult> => OK),
    renewCert: vi.fn(async (): Promise<SslResult> => OK),
    verifyCert: vi.fn(async (): Promise<SslResult> => OK),
  };
  return { routing, ssl };
}

/**
 * Executor serving a fixed cert/key from `readFile` (how the shared cert reader
 * reads declared paths) and recording `exec` so a test can assert nothing was
 * shelled for an unsafe path.
 */
function fakeExecutor(files: Record<string, string> = {}): CommandExecutor {
  return {
    exec: vi.fn(async () => ""),
    readFile: vi.fn(async (p: string) => {
      const hit = files[p];
      if (hit === undefined) throw new Error(`no such file: ${p}`);
      return hit;
    }),
  } as unknown as CommandExecutor;
}

const opts = () => ({ onLog: () => {}, warnings: [] as string[] });

describe("registerImportedSites", () => {
  it("registers a proxy site and a static site as routes", async () => {
    const { routing, ssl } = providers();
    const sites: ImportedSite[] = [
      { serverNames: ["a.com"], ssl: false, target: { kind: "proxy", url: "http://127.0.0.1:3000" } },
      { serverNames: ["b.com"], ssl: false, target: { kind: "static", root: "/var/www/b" } },
    ];
    const o = opts();
    const registered = await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, fakeExecutor(), sites, o);

    expect(registered).toEqual(["a.com", "b.com"]);
    // terminatesTlsLocally tracks `ssl`: a plain-HTTP imported site gets no TLS
    // listener, so no placeholder cert is minted for it either.
    expect(routing.registerRoute).toHaveBeenCalledWith({
      domain: "a.com",
      tls: false,
      terminatesTlsLocally: false,
      targetUrl: "http://127.0.0.1:3000",
    });
    // An imported root lives outside the managed base by nature, so it must be
    // registered as ADOPTED or assertValidStaticRoot refuses it.
    expect(routing.registerRoute).toHaveBeenCalledWith({
      domain: "b.com",
      tls: false,
      terminatesTlsLocally: false,
      staticRoot: "/var/www/b",
      staticRootAdopted: true,
    });
    expect(ssl.installCert).not.toHaveBeenCalled();
    expect(ssl.provisionCert).not.toHaveBeenCalled();
    expect(o.warnings).toEqual([]);
  });

  it("installs inline certPems without reading the filesystem", async () => {
    const { routing, ssl } = providers();
    const exec = fakeExecutor();
    const sites: ImportedSite[] = [
      {
        serverNames: ["a.com"],
        ssl: true,
        target: { kind: "proxy", url: "http://127.0.0.1:3000" },
        tls: { certPath: "/etc/ssl/a.crt", keyPath: "/etc/ssl/a.key" },
      },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, exec, sites, {
      onLog: () => {},
      warnings: [],
      certPems: { "/etc/ssl/a.crt": { certPem: "CERT", keyPem: "KEY" } },
    });

    expect(ssl.installCert).toHaveBeenCalledWith("a.com", { certPem: "CERT", keyPem: "KEY" });
    expect(ssl.provisionCert).not.toHaveBeenCalled();
    expect(exec.exec).not.toHaveBeenCalled(); // no `cat` — used the inline PEMs
  });

  it("reads a safe cert path via the executor when no inline PEM is given", async () => {
    const { routing, ssl } = providers();
    const cert = makeTestCert(["a.com"]);
    const exec = fakeExecutor({ "/etc/ssl/a.crt": cert.certPem, "/etc/ssl/a.key": cert.keyPem });
    const sites: ImportedSite[] = [
      {
        serverNames: ["a.com"],
        ssl: true,
        target: { kind: "proxy", url: "http://127.0.0.1:3000" },
        tls: { certPath: "/etc/ssl/a.crt", keyPath: "/etc/ssl/a.key" },
      },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, exec, sites, opts());

    expect(exec.readFile).toHaveBeenCalledWith("/etc/ssl/a.crt");
    expect(ssl.installCert).toHaveBeenCalledWith("a.com", {
      certPem: cert.certPem,
      keyPem: cert.keyPem,
    });
  });

  it("provisions a fresh cert and warns when the cert path is unsafe", async () => {
    const { routing, ssl } = providers();
    const exec = fakeExecutor();
    const sites: ImportedSite[] = [
      {
        serverNames: ["a.com"],
        ssl: true,
        target: { kind: "proxy", url: "http://127.0.0.1:3000" },
        tls: { certPath: "/etc/ssl/../$(whoami).crt", keyPath: "/etc/ssl/a.key" },
      },
    ];
    const o = opts();
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, exec, sites, o);

    expect(exec.exec).not.toHaveBeenCalled(); // never shell an unsafe path
    expect(exec.readFile).not.toHaveBeenCalled();
    expect(ssl.installCert).not.toHaveBeenCalled();
    expect(ssl.provisionCert).toHaveBeenCalledWith("a.com");
    expect(o.warnings.some((w) => w.includes("unsafe"))).toBe(true);
  });

  it("announces a fresh ACME issuance before the call so it isn't mistaken for a hang", async () => {
    // A migrate that can't carry a cert falls to a per-domain Let's Encrypt issuance
    // — the one step with real wall-clock cost. Reuse (installCert) is silent; the
    // fresh path must LOG, or a slow migrate looks hung with no attributable cause.
    const { routing, ssl } = providers();
    const logs: string[] = [];
    const sites: ImportedSite[] = [
      // No `tls` and no inline PEM → nothing to reuse → provisionCert.
      { serverNames: ["fresh.com"], ssl: true, target: { kind: "proxy", url: "http://127.0.0.1:3000" } },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, fakeExecutor(), sites, {
      onLog: (l) => logs.push(l.message),
      warnings: [],
    });

    expect(ssl.installCert).not.toHaveBeenCalled();
    expect(ssl.provisionCert).toHaveBeenCalledWith("fresh.com");
    expect(logs.some((m) => m.includes("fresh.com") && /requesting a new one/i.test(m))).toBe(true);
  });

  it("does NOT log a fresh issuance when an existing cert is reused", async () => {
    // The reuse branch must stay silent — a log there would cry wolf on the fast path.
    const { routing, ssl } = providers();
    const logs: string[] = [];
    const sites: ImportedSite[] = [
      { serverNames: ["a.com"], ssl: true, target: { kind: "proxy", url: "http://127.0.0.1:3000" } },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, fakeExecutor(), sites, {
      onLog: (l) => logs.push(l.message),
      warnings: [],
      certPems: { "a.com": { certPem: "CERT", keyPem: "KEY" } },
    });

    expect(ssl.installCert).toHaveBeenCalledWith("a.com", { certPem: "CERT", keyPem: "KEY" });
    expect(logs.some((m) => /requesting a new one/i.test(m))).toBe(false);
  });

  // The carry must not hand over a cert for the WRONG hostname. A vhost naming two
  // hosts off a single-name cert used to carry that cert to both, so the second
  // domain served a mismatched cert under a green padlock.
  it("refuses a cert that doesn't cover the domain and provisions instead", async () => {
    const { routing, ssl } = providers();
    const cert = makeTestCert(["a.com"]);
    const exec = fakeExecutor({ "/etc/ssl/a.crt": cert.certPem, "/etc/ssl/a.key": cert.keyPem });
    const sites: ImportedSite[] = [
      {
        serverNames: ["a.com", "b.com"],
        ssl: true,
        target: { kind: "proxy", url: "http://127.0.0.1:3000" },
        tls: { certPath: "/etc/ssl/a.crt", keyPath: "/etc/ssl/a.key" },
      },
    ];
    const o = opts();
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, exec, sites, o);

    expect(ssl.installCert).toHaveBeenCalledWith("a.com", expect.anything());
    expect(ssl.installCert).not.toHaveBeenCalledWith("b.com", expect.anything());
    expect(ssl.provisionCert).toHaveBeenCalledWith("b.com");
    expect(o.warnings.some((w) => w.includes("b.com") && w.includes("not b.com"))).toBe(true);
  });

  it("prefers an inline PEM keyed by HOSTNAME (caddy/traefik have no cert path)", async () => {
    const { routing, ssl } = providers();
    const exec = fakeExecutor();
    const sites: ImportedSite[] = [
      // No `tls` at all — exactly what the caddy/traefik parsers produce.
      { serverNames: ["a.com"], ssl: true, target: { kind: "proxy", url: "http://127.0.0.1:3000" } },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, exec, sites, {
      onLog: () => {},
      warnings: [],
      certPems: { "a.com": { certPem: "CERT", keyPem: "KEY" } },
    });

    expect(ssl.installCert).toHaveBeenCalledWith("a.com", { certPem: "CERT", keyPem: "KEY" });
    expect(ssl.provisionCert).not.toHaveBeenCalled();
  });

  it("skips wildcard/regex server names with a warning", async () => {
    const { routing, ssl } = providers();
    const sites: ImportedSite[] = [
      { serverNames: ["*.a.com", "ok.com"], ssl: false, target: { kind: "proxy", url: "http://127.0.0.1:3000" } },
    ];
    const o = opts();
    const registered = await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, fakeExecutor(), sites, o);

    expect(registered).toEqual(["ok.com"]);
    expect(o.warnings.some((w) => w.includes("*.a.com"))).toBe(true);
  });

  it("collects a per-domain error into warnings without aborting the batch", async () => {
    const { ssl } = providers();
    const routing = {
      registerRoute: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(undefined),
      removeRoute: vi.fn(async () => {}),
    };
    const sites: ImportedSite[] = [
      { serverNames: ["bad.com"], ssl: false, target: { kind: "proxy", url: "http://127.0.0.1:3000" } },
      { serverNames: ["good.com"], ssl: false, target: { kind: "proxy", url: "http://127.0.0.1:3001" } },
    ];
    const o = opts();
    const registered = await registerImportedSites(routing as unknown as RoutingProvider, ssl as SslProvider, fakeExecutor(), sites, o);

    expect(registered).toEqual(["good.com"]);
    expect(o.warnings.some((w) => w.includes("bad.com") && w.includes("boom"))).toBe(true);
  });

  /**
   * Taking :80/:443 over swaps the config every imported site is served from. A site
   * whose old vhost allowed 50 MB uploads starts 413-ing at nginx's 1 MB default the
   * moment we bind — a regression the operator never asked for and has no reason to
   * connect to the takeover.
   */
  it("carries the source vhost's tunables onto the route", async () => {
    const { routing, ssl } = providers();
    const sites: ImportedSite[] = [
      {
        serverNames: ["big.com"],
        ssl: false,
        target: { kind: "proxy", url: "http://127.0.0.1:3000" },
        proxy: { clientMaxBodySize: "50m", proxyReadTimeout: "300s" },
        // Verbatim display data — must NOT reach the renderer.
        proxyRaw: { clientMaxBodySize: "50m", proxyReadTimeout: "300s" },
      },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, fakeExecutor(), sites, opts());

    expect(routing.registerRoute).toHaveBeenCalledWith({
      domain: "big.com",
      tls: false,
      terminatesTlsLocally: false,
      targetUrl: "http://127.0.0.1:3000",
      proxy: { clientMaxBodySize: "50m", proxyReadTimeout: "300s" },
    });
  });

  it("carries them onto an adopted static root too", async () => {
    const { routing, ssl } = providers();
    const sites: ImportedSite[] = [
      {
        serverNames: ["static.com"],
        ssl: false,
        target: { kind: "static", root: "/var/www/s" },
        proxy: { gzip: true },
      },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, fakeExecutor(), sites, opts());

    expect(routing.registerRoute).toHaveBeenCalledWith({
      domain: "static.com",
      tls: false,
      terminatesTlsLocally: false,
      staticRoot: "/var/www/s",
      staticRootAdopted: true,
      proxy: { gzip: true },
    });
  });

  /**
   * A container edge can't read a docroot outside its bind mounts, so the CLI copies
   * the tree in host-side and hands the corrected root here keyed by primary hostname.
   * Substituting it (not the original) is what keeps the site from 500ing after
   * cutover — and what lands in the route sidecar cert renewal re-reads. See #456.
   */
  it("substitutes staticRootOverrides for an adopted static root, keyed by primary hostname", async () => {
    const { routing, ssl } = providers();
    const sites: ImportedSite[] = [
      { serverNames: ["front.com", "www.front.com"], ssl: false, target: { kind: "static", root: "/home/app/dist" } },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, fakeExecutor(), sites, {
      onLog: () => {},
      warnings: [],
      staticRootOverrides: { "front.com": "/opt/openship/static/_adopted/front.com" },
    });

    // Both server names register, and BOTH get the corrected root (the override keys
    // on the primary name that the copy was performed for).
    expect(routing.registerRoute).toHaveBeenCalledWith({
      domain: "front.com",
      tls: false,
      terminatesTlsLocally: false,
      staticRoot: "/opt/openship/static/_adopted/front.com",
      staticRootAdopted: true,
    });
    expect(routing.registerRoute).toHaveBeenCalledWith({
      domain: "www.front.com",
      tls: false,
      terminatesTlsLocally: false,
      staticRoot: "/opt/openship/static/_adopted/front.com",
      staticRootAdopted: true,
    });
  });

  it("falls back to the original root when no override matches the site", async () => {
    const { routing, ssl } = providers();
    const sites: ImportedSite[] = [
      { serverNames: ["b.com"], ssl: false, target: { kind: "static", root: "/var/www/b" } },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, fakeExecutor(), sites, {
      onLog: () => {},
      warnings: [],
      // A key for a DIFFERENT site (operator left this one) must not leak across.
      staticRootOverrides: { "other.com": "/opt/openship/static/_adopted/other.com" },
    });

    expect(routing.registerRoute).toHaveBeenCalledWith({
      domain: "b.com",
      tls: false,
      terminatesTlsLocally: false,
      staticRoot: "/var/www/b",
      staticRootAdopted: true,
    });
  });

  it("omits `proxy` entirely when the source vhost tuned nothing", async () => {
    // `proxy: undefined` and "no proxy key" are the same thing to the renderer, but
    // only the second keeps the RouteConfig sidecar clean.
    const { routing, ssl } = providers();
    const sites: ImportedSite[] = [
      {
        serverNames: ["plain.com"],
        ssl: false,
        target: { kind: "proxy", url: "http://127.0.0.1:3000" },
        // A vhost holding only values our validators reject parses to raw-only.
        proxyRaw: { proxyReadTimeout: "1d" },
      },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, fakeExecutor(), sites, opts());

    expect(routing.registerRoute.mock.calls[0]![0]).not.toHaveProperty("proxy");
  });
});
