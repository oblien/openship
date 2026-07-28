import { describe, it, expect, vi } from "vitest";
import { registerImportedSites } from "./takeover";
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

/** Executor that records `cat` reads (the ONLY thing registerImportedSites execs). */
function fakeExecutor(catResult: string | null = "PEM"): CommandExecutor {
  return {
    exec: vi.fn(async () => {
      if (catResult === null) throw new Error("not found");
      return catResult;
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
    expect(routing.registerRoute).toHaveBeenCalledWith({ domain: "a.com", tls: false, targetUrl: "http://127.0.0.1:3000" });
    expect(routing.registerRoute).toHaveBeenCalledWith({ domain: "b.com", tls: false, staticRoot: "/var/www/b" });
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
    const exec = fakeExecutor("FILE-PEM");
    const sites: ImportedSite[] = [
      {
        serverNames: ["a.com"],
        ssl: true,
        target: { kind: "proxy", url: "http://127.0.0.1:3000" },
        tls: { certPath: "/etc/ssl/a.crt", keyPath: "/etc/ssl/a.key" },
      },
    ];
    await registerImportedSites(routing as RoutingProvider, ssl as SslProvider, exec, sites, opts());

    expect(exec.exec).toHaveBeenCalled();
    expect(ssl.installCert).toHaveBeenCalledWith("a.com", { certPem: "FILE-PEM", keyPem: "FILE-PEM" });
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

    expect(exec.exec).not.toHaveBeenCalled(); // never `cat` an unsafe path
    expect(ssl.installCert).not.toHaveBeenCalled();
    expect(ssl.provisionCert).toHaveBeenCalledWith("a.com");
    expect(o.warnings.some((w) => w.includes("unsafe"))).toBe(true);
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
