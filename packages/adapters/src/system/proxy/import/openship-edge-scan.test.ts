import { describe, expect, it, vi } from "vitest";

import { scanForeignOpenResty, scanOpenshipEdge } from "./nginx";
import {
  OPENRESTY_DEFAULT_PATHS,
  edgeChallengeVhostConf,
  edgeDefaultCatchAllConf,
  edgeDefaultCertPaths,
} from "../../../infra/openresty-lua";
import type { CommandExecutor } from "../../../types";

const VHOST = `
server {
  listen 443 ssl;
  server_name app.example.com;
  ssl_certificate /etc/letsencrypt/live/app.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;
  location / { proxy_pass http://127.0.0.1:8080; }
}
`;

/**
 * Executor for a box whose edge runs as a CONTAINER with its sites tree in a
 * Docker-managed named volume: every host path is empty, `docker ps` finds the
 * container, and only a read from INSIDE it returns the vhosts.
 */
function containerEdgeHost(): CommandExecutor {
  return {
    exec: vi.fn(async (cmd: string) => {
      if (cmd.startsWith("docker ps --filter name=openship-edge")) return "openship-edge";
      if (cmd.startsWith("docker exec") && cmd.includes("cat ")) return VHOST;
      return ""; // host `cat` of every sites path: nothing there
    }),
  } as unknown as CommandExecutor;
}

describe("scanOpenshipEdge", () => {
  it("reads vhosts from the host when they're there, without touching Docker", async () => {
    const exec = vi.fn(async (cmd: string) => (cmd.startsWith("cat ") ? VHOST : ""));
    const result = await scanOpenshipEdge({ exec } as unknown as CommandExecutor);

    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]!.serverNames).toEqual(["app.example.com"]);
    expect(exec.mock.calls.some(([cmd]) => cmd.includes("docker"))).toBe(false);
  });

  it("cats the canonical bind-mounted sites dir as well as the bare-host layouts", async () => {
    const exec = vi.fn(async (_cmd: string) => "");
    await scanOpenshipEdge({ exec } as unknown as CommandExecutor);

    const cat = exec.mock.calls.map(([cmd]) => cmd).find((cmd) => cmd.startsWith("cat "))!;
    expect(cat).toContain("/var/lib/openship/edge/sites-enabled/*.conf");
    expect(cat).toContain("/usr/local/openresty/nginx/conf/sites-enabled/*.conf");
    expect(cat).toContain("/etc/openresty/sites-enabled/*.conf");
  });

  it("falls back to reading INSIDE the edge container when the host has nothing", async () => {
    // The reported regression: a compose box keeps its sites tree in a named volume
    // the host can't see, so the host read returned "" and the migrate wizard showed
    // zero domains and zero certs — indistinguishable from a box serving nothing.
    const result = await scanOpenshipEdge(containerEdgeHost());

    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]!.serverNames).toEqual(["app.example.com"]);
    expect(result.sites[0]!.ssl).toBe(true);
    expect(result.sites[0]!.tls?.certPath).toBe(
      "/etc/letsencrypt/live/app.example.com/fullchain.pem",
    );
  });

  /**
   * The scan is ONE `cat` over a glob, so every file the edge writes is parsed in the
   * same string — and `_default.conf` sorts first. A file we generate that the parser
   * mis-reads therefore doesn't lose itself, it loses everything after it. Both
   * generated files are fed here as the real bytes rather than fixtures, because the
   * regression (#431) was that the generator changed and no test read its output.
   */
  it("finds the real vhost with BOTH generated files ahead of it in the same cat", async () => {
    const catchAll = edgeDefaultCatchAllConf(
      edgeDefaultCertPaths(OPENRESTY_DEFAULT_PATHS.confDir),
    );
    // Sanity: the bytes under test really are the ones carrying the inlined page.
    expect(catchAll).toContain("return 404 '<!doctype html>");
    const dumped = [catchAll, edgeChallengeVhostConf("203.0.113.10"), VHOST].join("\n");
    const exec = vi.fn(async (cmd: string) => (cmd.startsWith("cat ") ? dumped : ""));

    const result = await scanOpenshipEdge({ exec } as unknown as CommandExecutor);

    // Exactly the one real site: the catch-all is `server_name _` and the challenge
    // vhost is scaffolding, so neither is a site — but the vhost AFTER them must
    // survive, cert and all (the migrate wizard's domain list and the cert carry both
    // read this).
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]!.serverNames).toEqual(["app.example.com"]);
    expect(result.sites[0]!.tls?.certPath).toBe(
      "/etc/letsencrypt/live/app.example.com/fullchain.pem",
    );
    // And no warning naming the challenge vhost: it is expected furniture, so
    // reporting it would read as "a site of yours won't migrate".
    expect(result.warnings.join("\n")).not.toContain("203.0.113.10");
  });

  it("does not import the edge-target challenge vhost as a static site", async () => {
    // It has a `root` (the challenge dir) and now a `location /` for the not-found
    // page. Read as a site, it would appear in the orphan sweep and the migrate import
    // as a static vhost rooted at a directory with no index — which the edge answers
    // with a 500 — and would claim the hostname away from the real deployment.
    const exec = vi.fn(async (cmd: string) =>
      cmd.startsWith("cat ") ? edgeChallengeVhostConf("box.example.com") : "",
    );
    const result = await scanOpenshipEdge({ exec } as unknown as CommandExecutor);
    expect(result.sites).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("returns empty (never throws) when there is no edge container either", async () => {
    const exec = vi.fn(async () => "");
    expect((await scanOpenshipEdge({ exec } as unknown as CommandExecutor)).sites).toEqual([]);
  });

  it("returns empty when the box is unreachable", async () => {
    const dead = { exec: vi.fn().mockRejectedValue(new Error("ssh timeout")) };
    expect((await scanOpenshipEdge(dead as unknown as CommandExecutor)).sites).toEqual([]);
  });
});

// `openresty -T` output for a legacy bare edge whose real vhost is `include`d from a
// path NONE of scanOpenshipEdge's fixed globs cover — the shape that made a takeover
// offer "takeover only" (drop every site) instead of a migrate.
const LEGACY_OPENRESTY_DUMP = `# configuration file /usr/local/openresty/nginx/conf/nginx.conf:
http {
  server {
    listen 80 default_server;
    server_name _;
    location / { return 404; }
  }
# configuration file /opt/legacy/vhosts/app.conf:
${VHOST}
}
`;

describe("scanForeignOpenResty", () => {
  it("finds a legacy bare edge's vhosts via `openresty -T`, not the fixed globs", async () => {
    // The reported bug: the vhost lives at a non-default include path, so the glob
    // `cat` returns nothing and the migrate offer collapsed to takeover-only. The
    // fully-resolved dump follows the include and surfaces the site.
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.startsWith("openresty -T")) return LEGACY_OPENRESTY_DUMP;
      return ""; // every glob `cat` is empty — the site is NOT in a known tree
    });
    const result = await scanForeignOpenResty({ exec } as unknown as CommandExecutor);

    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]!.serverNames).toEqual(["app.example.com"]);
    expect(result.sites[0]!.target).toEqual({ kind: "proxy", url: "http://127.0.0.1:8080" });
    // The dump is what surfaced it — never fell through to the glob cat.
    expect(exec.mock.calls.some(([cmd]) => cmd.startsWith("openresty -T"))).toBe(true);
  });

  it("falls back to the openship site trees when no dump is available (no binary / stopped-with-no-config)", async () => {
    // `openresty -T` yields nothing (binary absent) → the fixed-glob read still finds
    // an edge whose sites DO sit in a known tree.
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.startsWith("openresty -T")) return "";
      return cmd.startsWith("cat ") ? VHOST : "";
    });
    const result = await scanForeignOpenResty({ exec } as unknown as CommandExecutor);

    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]!.serverNames).toEqual(["app.example.com"]);
  });

  it("returns empty (never throws) when neither the dump nor the trees have anything", async () => {
    const exec = vi.fn(async () => "");
    expect((await scanForeignOpenResty({ exec } as unknown as CommandExecutor)).sites).toEqual([]);
  });
});
