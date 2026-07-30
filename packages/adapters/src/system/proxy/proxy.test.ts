import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../../types";
import type { EdgeStatus } from "../types";
import { importSites, foreignProxyOnEdge } from "./index";

/**
 * importSites is the single home for the "find the proxy occupant → is it
 * importable → scan it" triad that used to be copy-pasted in installer.ts,
 * self-edge.ts, and self-app.controller.ts. Assert the three branches.
 */

function makeExecutor(rules: Array<[string, string]>): CommandExecutor {
  return {
    exec: async (cmd: string) => {
      for (const [needle, out] of rules) if (cmd.includes(needle)) return out;
      return "";
    },
  } as unknown as CommandExecutor;
}

const nginxStatus: EdgeStatus = {
  classification: "known",
  canProceedClean: false,
  occupants: [{ port: 80, proxy: "nginx", managedByOpenship: false }],
};
const unknownStatus: EdgeStatus = {
  classification: "unknown",
  canProceedClean: false,
  occupants: [{ port: 80, managedByOpenship: false }],
};
const freeStatus: EdgeStatus = { classification: "free", canProceedClean: true, occupants: [] };

describe("importSites (proxy facade)", () => {
  test("scans an importable nginx occupant into sites", async () => {
    const exec = makeExecutor([
      ["nginx -T", "server { server_name a.example.com; location / { proxy_pass http://127.0.0.1:3000; } }"],
    ]);
    const res = await importSites(exec, nginxStatus);
    expect(res.sites.flatMap((s) => s.serverNames)).toContain("a.example.com");
  });

  test("returns empty for an unidentified (non-importable) occupant — never throws", async () => {
    const res = await importSites(makeExecutor([]), unknownStatus);
    expect(res.sites).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  test("returns empty when the edge is free", async () => {
    const res = await importSites(makeExecutor([]), freeStatus);
    expect(res.sites).toEqual([]);
  });
});

describe("foreignProxyOnEdge", () => {
  test("free edge → not blocked", async () => {
    const r = await foreignProxyOnEdge(makeExecutor([]));
    expect(r.blocked).toBe(false);
    expect(r.status.classification).toBe("free");
    expect(r.owner).toBe("");
  });

  test("a foreign /usr/sbin/nginx → blocked, owner names it", async () => {
    // No site_logger.lua on disk → not ours; nginx binary → foreign → 'known'.
    const r = await foreignProxyOnEdge(
      makeExecutor([
        ["sport = :80", 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=1234,fd=6))'],
        ["-p 1234 -o args=", "nginx: master process /usr/sbin/nginx -g daemon on;"],
        ["/proc/1234/cgroup", "0::/system.slice/nginx.service"],
        ["/proc/1234/exe", "/usr/sbin/nginx"],
      ]),
    );
    expect(r.blocked).toBe(true);
    expect(r.status.classification).toBe("known");
    expect(r.owner).toContain("nginx");
  });

  test("our own OpenResty on the edge → NOT blocked (it's ours)", async () => {
    const r = await foreignProxyOnEdge(
      makeExecutor([
        ["site_logger.lua", "ok"], // our Lua is deployed
        ["sport = :80", 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=555,fd=6))'],
        ["-p 555 -o args=", "nginx: master process /usr/local/openresty/nginx/sbin/nginx"],
      ]),
    );
    expect(r.blocked).toBe(false);
    expect(r.status.classification).toBe("ours");
  });
});
