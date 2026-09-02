import { describe, expect, it, vi } from "vitest";
import { renderSwarmEdgeRoute, swarmEdgeRouteConfigTarget, SwarmEdgeRouteManager } from "./edge-routes";

describe("Swarm Edge route configs", () => {
  it("renders a constrained service-DNS proxy and webroot ACME location", () => {
    const rendered = renderSwarmEdgeRoute({ domain: "app.example.test", serviceDnsName: "blog_web", port: 3000 }, false);
    expect(rendered).toContain("proxy_pass http://blog_web:3000;");
    expect(rendered).toContain("root /var/www/acme;");
    expect(rendered).not.toContain("ssl_certificate");
    expect(() => renderSwarmEdgeRoute({ domain: "app;bad", serviceDnsName: "blog_web", port: 3000 }, false)).toThrow(/domain/);
  });

  it("updates only its immutable config mount and removes a replaced config after convergence", async () => {
    const commands: string[] = [];
    const exec = vi.fn(async (command: string) => {
      commands.push(command);
      if (command.startsWith("umask 077")) return "/tmp/openship-swarm-edge-route.abc123";
      if (command.startsWith("docker service inspect")) return JSON.stringify([{
        ConfigName: "openship-edge-route-old",
        File: { Name: swarmEdgeRouteConfigTarget("app.example.test") },
      }]);
      return "";
    });
    const writeFile = vi.fn(async () => {});
    const rm = vi.fn(async () => {});
    const routes = new SwarmEdgeRouteManager({ exec, writeFile, rm });
    await routes.register({ domain: "app.example.test", serviceDnsName: "blog_web", port: 3000 });
    expect(commands.some((command) => command.startsWith("docker config create"))).toBe(true);
    const update = commands.find((command) => command.startsWith("docker service update"))!;
    expect(update).toContain("--config-rm 'openship-edge-route-old'");
    expect(update).toContain("--config-add");
    expect(update).toContain("'openship-edge'");
    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining("/route.conf"), expect.stringContaining("blog_web:3000"));
    expect(rm).toHaveBeenCalledWith("/tmp/openship-swarm-edge-route.abc123");
  });

  it("inspects a certificate on the pinned ingress volume, never on the manager host", async () => {
    const commands: string[] = [];
    const routes = new SwarmEdgeRouteManager({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command.startsWith("docker service logs")) {
          return "Expiry Date: 2026-10-28 12:00:00+00:00 (VALID: 89 days)";
        }
        return "";
      }),
      writeFile: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
    });

    await expect(routes.certificateStatus("app.example.test")).resolves.toMatchObject({
      verified: true,
      expiresAt: "2026-10-28T12:00:00.000Z",
    });
    expect(commands).toContainEqual(expect.stringContaining("docker service create"));
    expect(commands.join("\n")).toContain("openship-edge-certs");
    expect(commands.join("\n")).toContain("node.labels.openship.edge.ingress == true");
  });
});
