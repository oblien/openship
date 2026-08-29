import { describe, expect, it } from "vitest";
import { buildReloadCommand, detectOpenRestyPaths } from "./openresty-lua";
import {
  containerEdgeProvider,
  localContainerEdgeProvider,
} from "../system/proxy/ensure-container-edge";
import type { CommandExecutor } from "../types";

/**
 * The reload command's FAILURE path, which is where it could take a whole box
 * offline (#292) or start a second master that spends ~30 seconds trying to bind
 * ports already owned by the real one (#700).
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
  compiledConfPath: "/usr/local/openresty/nginx/conf/nginx.conf",
  confPath: "/usr/local/openresty/nginx/conf/nginx.conf",
  confDir: "/usr/local/openresty/nginx/conf",
  sitesDir: "/usr/local/openresty/nginx/conf/sites-enabled",
  pidPath: "/usr/local/openresty/nginx/logs/nginx.pid",
};

describe("detectOpenRestyPaths", () => {
  it("retains the compiled config when file management falls back to another tree", async () => {
    const compiled = "/usr/local/openresty/nginx/conf/nginx.conf";
    const fallback = "/etc/openresty/nginx.conf";
    const executor = {
      exec: async () =>
        `nginx version: openresty/1.27.1.1 --sbin-path=${paths.bin} --conf-path=${compiled} --pid-path=${paths.pidPath}`,
      exists: async (path: string) => path === fallback,
    } as unknown as CommandExecutor;

    await expect(detectOpenRestyPaths(executor)).resolves.toMatchObject({
      compiledConfPath: compiled,
      confPath: fallback,
    });
  });
});

describe("buildReloadCommand", () => {
  const cmd = buildReloadCommand(paths);

  it("never starts or kills a daemon", () => {
    expect(cmd).not.toMatch(/pkill/);
    expect(cmd).not.toMatch(/\bkill\b/);
    expect(cmd).not.toContain(`rm -f ${paths.pidPath}`);
    const lines = cmd.split("\n").map((line) => line.trim());
    expect(lines).not.toContain(paths.bin);
  });

  it("still validates before reloading, so a bad config can't be loaded", () => {
    expect(cmd).toContain(`'${paths.bin}' -t -c '${paths.confPath}'`);
    expect(cmd).toContain(`'${paths.bin}' -s reload -c '${paths.confPath}'`);
  });

  it("propagates both validation and reload failures", () => {
    expect(cmd).toMatch(/-t .*\|\| exit 1/);
    expect(cmd).toMatch(/-s reload .*\|\| exit 1/);
  });
});

describe("the container-edge builders use the same strict reload", () => {
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
