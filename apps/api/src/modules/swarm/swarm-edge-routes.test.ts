import { describe, expect, it } from "vitest";
import type { Domain, Project, Service, SwarmStack } from "@repo/db";
import { planSwarmEdgeRoutes } from "./swarm-edge-routes";

const project = { id: "project-a", slug: "blog", name: "Blog" } as Project;
const stack = { stackName: "blog", routingMode: "openship-edge" } as Pick<SwarmStack, "stackName" | "routingMode">;

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: "service-web",
    kind: "swarm",
    sourceServiceName: "web",
    name: "web",
    enabled: true,
    exposed: true,
    exposedPort: "3000",
    domainType: "custom",
    customDomain: "app.example.test",
    publicEndpoints: [],
    swarmProjection: { sourceServiceName: "web", mode: "replicated", sourceState: "present" },
    ...overrides,
  } as Service;
}

function domain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: "domain-app",
    hostname: "app.example.test",
    domainType: "custom",
    verified: false,
    sslStatus: "none",
    externalIngress: false,
    manualSsl: false,
    ...overrides,
  } as Domain;
}

describe("Swarm Edge domain planning", () => {
  it("routes an exposed service only through its stack-qualified Edge DNS identity", () => {
    const plan = planSwarmEdgeRoutes({ project, stack, services: [service()], domains: [domain()] });
    expect(plan.desired).toEqual([expect.objectContaining({
      input: { domain: "app.example.test", serviceDnsName: "blog_web", port: 3000 },
      serviceId: "service-web",
      domainType: "custom",
      provisionTls: true,
      tls: false,
    })]);
  });

  it("retains HTTP for external ingress and removes routes owned by a source service that disappeared", () => {
    const plan = planSwarmEdgeRoutes({
      project,
      stack,
      services: [
        service({ swarmProjection: { sourceServiceName: "web", mode: "replicated", sourceState: "removed" } }),
      ],
      domains: [domain({ externalIngress: true })],
    });
    expect(plan.desired).toEqual([]);
    expect(plan.retiredDomains).toEqual(["app.example.test"]);
  });

  it("does not create routes while the stack remains externally routed", () => {
    const plan = planSwarmEdgeRoutes({
      project,
      stack: { ...stack, routingMode: "external" },
      services: [service()],
      domains: [domain()],
    });
    expect(plan).toEqual({ desired: [], retiredDomains: [], warnings: [] });
  });
});
