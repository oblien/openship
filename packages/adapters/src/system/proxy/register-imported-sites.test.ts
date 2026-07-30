import { describe, it, expect, vi } from "vitest";
import { registerImportedSites } from "./takeover";
import { makeTestCert } from "./test-certs";
import type { CommandExecutor, SslResult } from "../../types";
import type { ImportedSite } from "../types";
import type { RoutingProvider, SslProvider } from "../../infra/types";

const OK: SslResult = { domain: "", expiresAt: "", issuer: "", verified: true };

/** Minimal provider doubles capturing the calls registerImportedSites makes. */
function providers() {
  const routing = { registerRoute: vi.fn(async () => {}), removeRoute: vi.fn(async () => {}) };
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
});
