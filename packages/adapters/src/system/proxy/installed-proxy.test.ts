import { describe, expect, it, vi } from "vitest";

import { detectInstalledProxy } from "./import";
import type { CommandExecutor } from "../../types";

/** Executor whose `exec` echoes the markers for the paths we say exist. */
function hostWith(paths: string[]): CommandExecutor {
  return {
    exec: vi.fn(async (cmd: string) => {
      // Mirror the shell the probe builds: emit a marker per satisfied test.
      const out: string[] = [];
      if (paths.includes("/etc/nginx/nginx.conf") && cmd.includes("/etc/nginx/nginx.conf")) {
        out.push("nginx");
      }
      if (paths.includes("/etc/caddy/Caddyfile") && cmd.includes("/etc/caddy/Caddyfile")) {
        out.push("caddy");
      }
      if (
        (paths.includes("/etc/apache2/apache2.conf") || paths.includes("/etc/httpd/conf/httpd.conf")) &&
        cmd.includes("apache2.conf")
      ) {
        out.push("apache");
      }
      return out.join("\n");
    }),
  } as unknown as CommandExecutor;
}

describe("detectInstalledProxy", () => {
  it("finds a stopped nginx by its on-disk config", async () => {
    // The regression this exists for: once a takeover stops the operator's nginx it
    // holds no ports, so probeEdge can't see it and its vhosts are stranded — even
    // though every site is still in /etc/nginx.
    expect(await detectInstalledProxy(hostWith(["/etc/nginx/nginx.conf"]))).toBe("nginx");
  });

  it("finds caddy and apache too", async () => {
    expect(await detectInstalledProxy(hostWith(["/etc/caddy/Caddyfile"]))).toBe("caddy");
    expect(await detectInstalledProxy(hostWith(["/etc/apache2/apache2.conf"]))).toBe("apache");
  });

  it("returns null on a host with no proxy installed", async () => {
    expect(await detectInstalledProxy(hostWith([]))).toBeNull();
  });

  it("prefers nginx when several are installed (most likely the active one)", async () => {
    const host = hostWith(["/etc/nginx/nginx.conf", "/etc/caddy/Caddyfile"]);
    expect(await detectInstalledProxy(host)).toBe("nginx");
  });

  it("never matches OUR OpenResty — that would offer to import our own edge", async () => {
    const host = hostWith(["/usr/local/openresty/nginx/conf/nginx.conf"]);
    expect(await detectInstalledProxy(host)).toBeNull();
  });

  it("returns null (never throws) when the host is unreachable", async () => {
    const dead = { exec: vi.fn().mockRejectedValue(new Error("ssh timeout")) } as unknown as CommandExecutor;
    expect(await detectInstalledProxy(dead)).toBeNull();
  });

  it("bounds the probe so a hung host can't stall the install", async () => {
    const host = hostWith(["/etc/nginx/nginx.conf"]);
    await detectInstalledProxy(host);
    const opts = (host.exec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
      timeout?: number;
    };
    expect(opts?.timeout).toBeGreaterThan(0);
  });

  it("cannot fail the whole probe when one marker test errors (exit 0 shell)", async () => {
    const host = hostWith(["/etc/nginx/nginx.conf"]);
    await detectInstalledProxy(host);
    const cmd = (host.exec as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    // `; true` keeps a non-zero test from making executor.exec reject.
    expect(cmd).toMatch(/;\s*true\s*$/);
  });
});
