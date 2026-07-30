import { describe, expect, it, vi } from "vitest";

import { scanOpenshipEdge } from "./nginx";
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

  it("returns empty (never throws) when there is no edge container either", async () => {
    const exec = vi.fn(async () => "");
    expect((await scanOpenshipEdge({ exec } as unknown as CommandExecutor)).sites).toEqual([]);
  });

  it("returns empty when the box is unreachable", async () => {
    const dead = { exec: vi.fn().mockRejectedValue(new Error("ssh timeout")) };
    expect((await scanOpenshipEdge(dead as unknown as CommandExecutor)).sites).toEqual([]);
  });
});
