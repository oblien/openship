/**
 * A host OpenResty is a MIGRATION SOURCE, not "us".
 *
 * That distinction only became true when the edge became a container: while the bare
 * edge was Openship itself, treating `/usr/local/openresty/...` as ours was correct.
 * Now the container's config lives inside its image and its host-side state is the
 * `/var/lib/openship/edge` bind mount, so a host OpenResty is someone's proxy to
 * migrate from — including an older Openship's own bare edge.
 */
import { describe, expect, it } from "vitest";
import { canImportProxy, scanImportableSites } from "./index";
import type { CommandExecutor } from "../../../types";

function fakeExecutor(files: Record<string, string>): CommandExecutor {
  return {
    exec: async (cmd: string) => {
      // `test -f <path> && echo ok` style probes
      for (const path of Object.keys(files)) {
        if (cmd.includes(path)) return files[path]!;
      }
      return "";
    },
    streamExec: async () => ({ code: 0, output: "" }),
    writeFile: async () => {},
    readFile: async () => "",
    exists: async (path: string) => path in files,
    mkdir: async () => {},
    rm: async () => {},
  } as unknown as CommandExecutor;
}

describe("openresty as an importable proxy", () => {
  it("is importable — not takeover-only", () => {
    // Takeover-only means "drop every vhost it serves", which for the proxy whose
    // config we parse most reliably would be the worst possible default.
    expect(canImportProxy("openresty")).toBe(true);
  });

  it("keeps the other proxies importable and haproxy not", () => {
    expect(canImportProxy("nginx")).toBe(true);
    expect(canImportProxy("caddy")).toBe(true);
    expect(canImportProxy("apache")).toBe(true);
    expect(canImportProxy("traefik")).toBe(true);
    expect(canImportProxy("haproxy")).toBe(false);
    expect(canImportProxy(undefined)).toBe(false);
  });

  it("scanning an openresty source returns a result rather than an unsupported warning", async () => {
    const res = await scanImportableSites(fakeExecutor({}), "openresty");
    expect(res.warnings.join(" ")).not.toMatch(/not supported/);
  });

  it("surfaces a running legacy edge's sites via `openresty -T` so migrate is offered", async () => {
    // The end-to-end regression: the consent gate and the migration feature both scan
    // through here. A legacy bare edge serving one site returned zero (its vhost wasn't
    // in a known glob), so the operator only ever saw "takeover only" — i.e. drop it.
    const exec = async (cmd: string) =>
      cmd.startsWith("openresty -T")
        ? "http {\n  server {\n    server_name legacy.example.com;\n    location / { proxy_pass http://127.0.0.1:9000; }\n  }\n}\n"
        : "";
    const res = await scanImportableSites({ exec } as unknown as CommandExecutor, "openresty");

    expect(res.sites.map((s) => s.serverNames).flat()).toContain("legacy.example.com");
  });

  it("haproxy still reports takeover-only", async () => {
    const res = await scanImportableSites(fakeExecutor({}), "haproxy");
    expect(res.warnings.join(" ")).toMatch(/takeover only/);
  });
});
