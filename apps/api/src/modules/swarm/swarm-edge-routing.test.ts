import { describe, expect, it } from "vitest";
import type { Service, SwarmStack } from "@repo/db";
import { planSwarmEdgeAttachments } from "./swarm-edge-routing";

function stack(routingMode: "external" | "openship-edge") {
  return { routingMode, stackName: "blog" } as Pick<SwarmStack, "routingMode" | "stackName">;
}

function row(overrides: Record<string, unknown> = {}) {
  return { id: "svc-web", name: "web", sourceServiceName: "web", enabled: true, exposed: true, exposedPort: "3000", ...overrides } as Service;
}

describe("Swarm Edge attachment plan", () => {
  it("attaches only explicit exposed services with a unique stable DNS alias", () => {
    expect(planSwarmEdgeAttachments(stack("openship-edge"), ["web", "db"], [row(), row({ id: "svc-db", name: "db", sourceServiceName: "db", exposed: false })])).toEqual({
      networkAttachments: { web: { networkName: "openship-edge", aliases: ["blog_web"] } },
      externalNetworks: { "openship-edge": "openship-edge" },
      upstreams: [{ sourceServiceName: "web", serviceDnsName: "blog_web", port: 3000 }],
    });
  });

  it("does nothing in external routing mode and rejects an exposed service without a port", () => {
    expect(planSwarmEdgeAttachments(stack("external"), ["web"], [row()])).toBeNull();
    expect(() => planSwarmEdgeAttachments(stack("openship-edge"), ["web"], [row({ exposedPort: null })])).toThrow(/explicit container port/);
  });
});
