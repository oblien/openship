import { describe, expect, test, vi } from "vitest";
import { NginxProvider, type NginxProviderOptions } from "./nginx";
import { OPENRESTY_DEFAULT_PATHS } from "./openresty-lua";
import type { CommandExecutor, RouteConfig } from "../types";

// Windows control planes must still produce remote (target Linux) paths with
// forward slashes. The source already switched to `node:path/posix`; this test
// makes sure a `node:path` default of `win32` cannot reintroduce backslashes.
const win32Path = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path/win32") as typeof import("node:path");
  return { ...path, default: path };
});

vi.mock("node:path", () => win32Path);

const SITES = "/var/lib/openship/edge/sites-enabled";
const CERT = "/etc/letsencrypt/live";

interface FakeExecutor extends CommandExecutor {
  writes: Array<{ path: string; content: string }>;
}

function makeExecutor(): FakeExecutor {
  const files = new Map<string, string>();
  const writes: Array<{ path: string; content: string }> = [];

  function recordWrite(p: string, c: string) {
    writes.push({ path: p, content: c });
    files.set(p, c);
  }

  const executor = {
    writes,
    exec: async (command: string) => {
      const singleMv = command.match(/^mv '([^']+)' '([^']+)'$/);
      if (singleMv) {
        const [, src, dest] = singleMv;
        const c = files.get(src);
        if (c !== undefined) {
          files.set(dest, c);
          recordWrite(dest, c);
          files.delete(src);
        }
        return "";
      }
      if (command.startsWith("mv -f ")) {
        const paths = [...command.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
        const dir = paths.pop()!;
        for (const src of paths) {
          const c = files.get(src);
          if (c !== undefined) {
            const dest = `${dir.replace(/\/$/, "")}/${src.split(/[\\/]/).pop()!}`;
            files.set(dest, c);
            recordWrite(dest, c);
            files.delete(src);
          }
        }
        return "";
      }
      if (command.startsWith("chmod ")) return "";
      if (/\s-V\b|command -v|which\s/.test(command)) throw new Error("no openresty in test");
      return "";
    },
    writeFile: async (p: string, c: string) => {
      files.set(p, c);
    },
    readFile: async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    exists: async (p: string) => files.has(p) || p.startsWith(`${CERT}/`),
    mkdir: async () => {},
    rm: async (p: string) => {
      files.delete(p);
    },
  };
  return executor as unknown as FakeExecutor;
}

function setup() {
  const executor = makeExecutor();
  const nginx = new NginxProvider({
    paths: {
      ...OPENRESTY_DEFAULT_PATHS,
      sitesDir: SITES,
    },
    executor,
    certDir: CERT,
  } as unknown as NginxProviderOptions);
  return { nginx, executor };
}

describe("NginxProvider remote path construction", () => {
  test("vhost path uses forward slashes even when the host `node:path` is win32", async () => {
    const { nginx, executor } = setup();
    await nginx.registerRoute({
      domain: "app.example.com",
      tls: true,
      targetUrl: "http://127.0.0.1:3009",
    } as unknown as RouteConfig);

    const vhostWrite = executor.writes.find((w) => w.path.endsWith(".conf"));
    expect(vhostWrite).toBeDefined();
    expect(vhostWrite!.path).toBe(`${SITES}/app-example-com.conf`);
    expect(vhostWrite!.path).not.toContain("\\");
  });
});
