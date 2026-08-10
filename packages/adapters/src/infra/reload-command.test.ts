import { describe, expect, it } from "vitest";
import { buildReloadCommand } from "./openresty-lua";
import { containerEdgeProvider, localContainerEdgeProvider } from "../system/proxy/ensure-container-edge";
import type { CommandExecutor } from "../types";

/**
 * The reload command's FAILURE path, which is where it could take a whole box
 * offline (#292: "opening project logs causes openship-edge to crash/restart").
 *
 * The old fallback was `pkill -f '[o]penresty'`. Inside the edge container that
 * pattern matches the container's own master — which is pid 1 — so a single failed
 * reload exited the container, the restart policy brought it back, and every
 * proxied site 502'd in between. The codebase already knew this shape: the
 * uninstall path documents it (edge-check.test.ts) because `pkill -f openresty`
 * also matches a HOST-NETWORKED container's master from the host side.
 */

const paths = {
  bin: "/usr/local/openresty/bin/openresty",
  confPath: "/usr/local/openresty/nginx/conf/nginx.conf",
  confDir: "/usr/local/openresty/nginx/conf",
  sitesDir: "/usr/local/openresty/nginx/conf/sites-enabled",
  pidPath: "/usr/local/openresty/nginx/logs/nginx.pid",
};

describe("buildReloadCommand — container edge", () => {
  const cmd = buildReloadCommand(paths, { containerEdge: true });

  it("never kills anything: the master is pid 1", () => {
    expect(cmd).not.toMatch(/pkill/);
    expect(cmd).not.toMatch(/\bkill\b/);
  });

  it("still validates before reloading, so a bad config can't be loaded", () => {
    expect(cmd).toContain(`${paths.bin} -t`);
    expect(cmd).toContain(`${paths.bin} -s reload`);
  });

  it("fails loudly instead of restarting the process itself", () => {
    // No bare `<bin>` start line — starting a second master inside a container
    // whose pid 1 is already the master is never the answer.
    const lines = cmd.split("\n").map((l) => l.trim());
    expect(lines.some((l) => l === paths.bin)).toBe(false);
    // Both steps propagate failure to the caller (who can `docker restart`).
    expect(cmd).toMatch(/-t .*\|\| exit 1/);
    expect(cmd).toMatch(/-s reload .*\|\| exit 1/);
  });
});

describe("buildReloadCommand — bare host", () => {
  const cmd = buildReloadCommand(paths);

  it("no longer pattern-kills — that also matches a host-networked edge container", () => {
    expect(cmd).not.toMatch(/pkill/);
  });

  it("still recovers a stopped OpenResty by starting it", () => {
    expect(cmd).toContain(`rm -f ${paths.pidPath}`);
    expect(cmd.trim().endsWith(paths.bin)).toBe(true);
  });

  it("refuses to kill a master that IS alive but wouldn't reload", () => {
    // The only way to reach the fallback with a live master is a stale/mismatched
    // pid file. Killing an unidentified process is worse than reporting it.
    expect(cmd).toContain(`kill -0`);
    expect(cmd).toMatch(/refused -s reload/);
    expect(cmd).toMatch(/exit 1/);
  });
});

describe("the container-edge builders opt in", () => {
  // Both builders are the ONLY places that know commands run inside the edge, so
  // the flag has to be set there — inferring it elsewhere is how it drifts.
  const exec = { exec: async () => "" } as unknown as CommandExecutor;

  it("containerEdgeProvider produces a kill-free reload", async () => {
    const provider = await containerEdgeProvider(exec, "openship-edge");
    const cmd = (provider as unknown as { reloadCommand: string }).reloadCommand;
    expect(cmd).not.toMatch(/pkill/);
    expect(cmd).toContain("-s reload");
  });

  it("localContainerEdgeProvider produces a kill-free reload", async () => {
    const provider = await localContainerEdgeProvider("openship-edge");
    const cmd = (provider as unknown as { reloadCommand: string }).reloadCommand;
    expect(cmd).not.toMatch(/pkill/);
    expect(cmd).toContain("-s reload");
  });
});
