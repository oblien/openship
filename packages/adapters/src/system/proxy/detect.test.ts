import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../../types";
import { probeEdge, stopTargetsForStatus } from "./detect";

/** Fake executor: maps a command (by substring) to canned stdout. Unmatched → "". */
function makeExecutor(rules: Array<[string, string]>): CommandExecutor {
  const exec = async (cmd: string): Promise<string> => {
    for (const [needle, out] of rules) {
      if (cmd.includes(needle)) return out;
    }
    return "";
  };
  return { exec } as unknown as CommandExecutor;
}

describe("probeEdge classification", () => {
  test("free when nothing listens on 80/443", async () => {
    const status = await probeEdge(makeExecutor([]));
    expect(status.classification).toBe("free");
    expect(status.occupants).toHaveLength(0);
    expect(status.canProceedClean).toBe(true);
  });

  test("ours when the edge is our own OpenResty", async () => {
    const status = await probeEdge(
      makeExecutor([
        ["site_logger.lua", "ok"],
        ["sport = :80", "LISTEN 0 511 *:80 *:* users:((\"nginx\",pid=555,fd=6))"],
        ["sport = :443", "LISTEN 0 511 *:443 *:* users:((\"nginx\",pid=555,fd=8))"],
        ["-p 555 -o args=", "nginx: master process /usr/local/openresty/nginx/sbin/nginx"],
      ]),
    );
    expect(status.classification).toBe("ours");
    expect(status.occupants).toHaveLength(0);
    expect(status.canProceedClean).toBe(true);
  });

  test("known when a foreign nginx (systemd) owns the ports", async () => {
    const status = await probeEdge(
      makeExecutor([
        ["sport = :80", "LISTEN 0 511 *:80 *:* users:((\"nginx\",pid=1234,fd=6))"],
        ["sport = :443", "LISTEN 0 511 *:443 *:* users:((\"nginx\",pid=1234,fd=8))"],
        ["-p 1234 -o args=", "nginx: master process /usr/sbin/nginx -g daemon on;"],
        ["/proc/1234/cgroup", "0::/system.slice/nginx.service"],
        ["systemctl show nginx.service", "A high performance web server"],
      ]),
    );
    expect(status.classification).toBe("known");
    expect(status.canProceedClean).toBe(false);
    const t = stopTargetsForStatus(status);
    expect(t.some((x) => x.unit === "nginx.service")).toBe(true);
    expect(status.occupants.every((o) => o.proxy === "nginx")).toBe(true);
  });

  test("REGRESSION: a foreign /usr/sbin/nginx is NOT 'ours' just because our Lua is on disk", async () => {
    // The hekai.org failure: a prior run left site_logger.lua behind (ourEdge=true),
    // but the process on :80 is the distro nginx — it must still be a takeover target,
    // never silently classified as our managed edge (which skipped the takeover).
    const status = await probeEdge(
      makeExecutor([
        ["site_logger.lua", "ok"], // our Lua from a past attempt
        ["sport = :80", "LISTEN 0 511 *:80 *:* users:((\"nginx\",pid=1234,fd=6))"],
        ["sport = :443", "LISTEN 0 511 *:443 *:* users:((\"nginx\",pid=1234,fd=8))"],
        ["-p 1234 -o args=", "nginx: master process /usr/sbin/nginx -g daemon on;"],
        ["/proc/1234/cgroup", "0::/system.slice/nginx.service"],
        ["/proc/1234/exe", "/usr/sbin/nginx"],
        ["systemctl show nginx.service", "A high performance web server"],
      ]),
    );
    expect(status.classification).toBe("known");
    expect(status.canProceedClean).toBe(false);
    expect(status.occupants.length).toBeGreaterThan(0);
    expect(status.occupants.every((o) => o.managedByOpenship === false)).toBe(true);
  });

  test("known when a dockerized traefik owns the ports", async () => {
    const status = await probeEdge(
      makeExecutor([
        ["docker ps --filter publish=80", "traefik-1\ttraefik:v3.0"],
        ["docker ps --filter publish=443", "traefik-1\ttraefik:v3.0"],
      ]),
    );
    expect(status.classification).toBe("known");
    expect(status.occupants[0]?.isDocker).toBe(true);
    expect(status.occupants[0]?.proxy).toBe("traefik");
    expect(stopTargetsForStatus(status).some((x) => x.container === "traefik-1")).toBe(true);
  });

  test("unknown when an unrecognized process holds a port", async () => {
    const status = await probeEdge(
      makeExecutor([
        ["sport = :80", "LISTEN 0 5 *:80 *:* users:((\"python3\",pid=999,fd=3))"],
        ["-p 999 -o args=", "python3 -m http.server 80"],
      ]),
    );
    expect(status.classification).toBe("unknown");
    expect(status.canProceedClean).toBe(false);
    expect(status.occupants[0]?.proxy).toBeUndefined();
  });
});
