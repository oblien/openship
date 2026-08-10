import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/db", () => ({ repos: {} }));

import { NginxProvider, EDGE_HOST_PATHS, type CommandExecutor } from "@repo/adapters";
import { reconcileProjectRoutes } from "../../src/lib/route-apply.service";

/**
 * The whole chain in one assertion, with the REAL renderer: a value stored on
 * `project.routingConfig.proxy` → `reconcileProjectRoutes` (@repo/api) →
 * `sanitizeProxySettings` (@repo/core) → `NginxProvider.registerRoute`
 * (@repo/adapters) → the vhost text actually written to disk.
 *
 * The per-layer tests each mock their neighbour, so all three can pass while the
 * seam between them is wrong — the field could be read, sanitized, and handed to a
 * renderer that never emits it. This is the test that says the operator's typed
 * "50m" reaches nginx.
 */

const SITES = EDGE_HOST_PATHS.sitesDir;

/** In-memory executor: file ops hit a Map, `-V` detection throws so the provider
 *  keeps its configured paths, and the reload script is a no-op success. */
function fakeExecutor(files: Map<string, string>): CommandExecutor {
  return {
    exec: async (command: string) => {
      if (/\s-V\b|command -v|which\s/.test(command)) throw new Error("no openresty in test");
      const mv = command.match(/^mv '([^']+)' '([^']+)'$/);
      if (mv) {
        const c = files.get(mv[1]!);
        if (c !== undefined) {
          files.set(mv[2]!, c);
          files.delete(mv[1]!);
        }
      }
      return "";
    },
    writeFile: async (p: string, c: string) => void files.set(p, c),
    readFile: async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    exists: async (p: string) => files.has(p),
    mkdir: async () => {},
    rm: async (p: string) => void files.delete(p),
  } as unknown as CommandExecutor;
}

const project = (proxy?: unknown) => ({
  id: "proj-1",
  organizationId: "org-1",
  cloudWorkspaceId: null,
  activeDeploymentId: "dep-1",
  webhookDomain: null,
  routingConfig: proxy ? ({ proxy } as never) : null,
});

async function applyAndRead(proxy?: unknown) {
  const files = new Map<string, string>();
  const routing = new NginxProvider({
    paths: EDGE_HOST_PATHS,
    executor: fakeExecutor(files),
  });
  await reconcileProjectRoutes(project(proxy), {
    routing: routing as never,
    registers: [
      { hostname: "app.example.com", targetUrl: "http://127.0.0.1:3000", isCustomDomain: false },
    ],
  });
  return files.get(`${SITES}/app-example-com.conf`) ?? "";
}

describe("project request limits reach the generated nginx config", () => {
  it("emits every configured directive into the vhost", async () => {
    const conf = await applyAndRead({
      clientMaxBodySize: "50m",
      proxyReadTimeout: "300s",
      proxySendTimeout: "300s",
      clientBodyTimeout: "300s",
      proxyBuffering: false,
      gzip: true,
    });

    expect(conf).toContain("client_max_body_size 50m;");
    expect(conf).toContain("proxy_read_timeout 300s;");
    expect(conf).toContain("proxy_send_timeout 300s;");
    expect(conf).toContain("client_body_timeout 300s;");
    expect(conf).toContain("proxy_buffering off;");
    expect(conf).toContain("gzip on;");
  });

  it("emits them at SERVER scope, not inside `location /`", async () => {
    // Inside `location /` the body limit would not apply to the webhook location or
    // any path-prefix proxy the project also owns.
    const conf = await applyAndRead({ clientMaxBodySize: "50m" });
    expect(conf.indexOf("client_max_body_size 50m;")).toBeLessThan(conf.indexOf("location / {"));
  });

  it("emits nothing when the project configures nothing", async () => {
    const conf = await applyAndRead();
    expect(conf).not.toContain("client_max_body_size");
    expect(conf).not.toContain("proxy_read_timeout");
    // A vhost was still written — this is the no-limits path, not a failure path.
    expect(conf).toContain("server_name app.example.com;");
  });

  it("a malformed stored value reaches nginx as nothing at all", async () => {
    // The injection case: `;` would close the directive and open a new one. It must
    // be dropped, not escaped into the file.
    const conf = await applyAndRead({ clientMaxBodySize: "50m; root /etc" });
    expect(conf).not.toContain("root /etc");
    expect(conf).not.toContain("client_max_body_size");
  });
});
