import { describe, it, expect } from "vitest";
import type { Service } from "@/lib/api/services";
import {
  hasConnectedDomain,
  isPotentiallyPublicService,
  shouldWarnAboutUnreachableServices,
  serviceMatchesPort,
} from "./redeploy-unreachable-warning";

describe("serviceMatchesPort", () => {
  it("matches exposedPort", () => {
    const svc = { exposedPort: "9000", ports: ["20020:9000"] };
    expect(serviceMatchesPort(svc, 9000)).toBe(true);
    expect(serviceMatchesPort(svc, "9000")).toBe(true);
    expect(serviceMatchesPort(svc, 8000)).toBe(false);
  });

  it("matches container port in host:container port mapping", () => {
    const svc = { exposedPort: null, ports: ["20020:9000"] };
    expect(serviceMatchesPort(svc, 9000)).toBe(true);
    expect(serviceMatchesPort(svc, 20020)).toBe(true);
    expect(serviceMatchesPort(svc, 3000)).toBe(false);
  });

  it("matches port with protocol suffix", () => {
    const svc = { exposedPort: null, ports: ["8080:80/tcp"] };
    expect(serviceMatchesPort(svc, 80)).toBe(true);
    expect(serviceMatchesPort(svc, 8080)).toBe(true);
    expect(serviceMatchesPort(svc, 443)).toBe(false);
  });

  it("does not confuse UDP routes, addresses or invalid port numbers with HTTP ports", () => {
    const svc = { exposedPort: null, ports: ["127.0.0.1:8080:80/tcp", "5353:53/udp"] };
    expect(serviceMatchesPort(svc, 8080)).toBe(true);
    expect(serviceMatchesPort(svc, "127.0.0.1")).toBe(false);
    expect(serviceMatchesPort(svc, 53)).toBe(false);
    expect(serviceMatchesPort({ ports: ["70000:80"], exposedPort: null }, 70000)).toBe(false);
    expect(serviceMatchesPort({ ports: ["0:80"], exposedPort: null }, 0)).toBe(false);
  });
});

describe("hasConnectedDomain", () => {
  const baseService: Service = {
    id: "svc_proxy",
    name: "proxy",
    kind: "compose",
    image: "proxy:latest",
    build: null,
    dockerfile: null,
    buildArgs: null,
    ports: ["20020:9000"],
    dependsOn: [],
    environment: {},
    volumes: [],
    command: null,
    restart: "unless-stopped",
    exposed: true,
    exposedPort: "9000",
    domain: "",
    customDomain: "",
    domainType: "free",
    publicEndpoints: [],
    enabled: true,
    sortOrder: 0,
  };

  it("recognizes persisted service routes even when the exposure scalar is off", () => {
    const svc = { ...baseService, exposed: false };
    const domains = [{ serviceId: "svc_proxy", hostname: "example.com" }];
    expect(hasConnectedDomain(svc, domains)).toBe(true);
  });

  it("returns true when domain table record links directly via serviceId", () => {
    const svc = { ...baseService, domain: "", customDomain: "" };
    const domains = [
      { id: "dom_1", serviceId: "svc_proxy", hostname: "archive.rschl.de", targetPort: 9000 },
    ];
    expect(hasConnectedDomain(svc, domains)).toBe(true);
  });

  it("returns true when domain table record matches service targetPort", () => {
    const svc = { ...baseService, id: "svc_other", domain: "", customDomain: "" };
    const domains = [
      { id: "dom_1", serviceId: null, hostname: "archive.rschl.de", targetPort: 9000 },
    ];
    expect(hasConnectedDomain(svc, domains)).toBe(true);
  });

  it("uses the project port for legacy project domains without a targetPort", () => {
    const svc = { ...baseService, exposed: false };
    const domains = [
      { id: "dom_1", serviceId: null, hostname: "archive.rschl.de", targetPort: null },
    ];
    expect(hasConnectedDomain(svc, domains, 9000)).toBe(true);
    expect(hasConnectedDomain(svc, domains, 20020)).toBe(true);
    expect(hasConnectedDomain(svc, domains, 3000)).toBe(false);
    expect(hasConnectedDomain(svc, domains)).toBe(false);
    expect(hasConnectedDomain(svc, [{ ...domains[0], targetPath: "/public" }], 9000)).toBe(false);
  });

  it("does not assign another service's domain just because it has the same port", () => {
    const svc = { ...baseService, exposed: false };
    const domains = [{ serviceId: "svc_other", hostname: "other.example.com", targetPort: 9000 }];
    expect(hasConnectedDomain(svc, domains, 9000)).toBe(false);
  });

  it("recognizes an unexposed service routed by a project-level published port", () => {
    const svc = { ...baseService, exposed: false };
    expect(hasConnectedDomain(svc, [{ hostname: "app.example.com", targetPort: 20020 }])).toBe(
      true,
    );
    expect(hasConnectedDomain(svc, [{ hostname: " ", targetPort: 20020 }])).toBe(false);
  });

  it("returns true when service has publicEndpoints with customDomain", () => {
    const svc: Service = {
      ...baseService,
      publicEndpoints: [{ port: 9000, domainType: "custom", customDomain: "api.example.com" }],
    };
    expect(hasConnectedDomain(svc, [])).toBe(true);
  });

  it("returns true when service has scalar customDomain", () => {
    const svc: Service = {
      ...baseService,
      domainType: "custom",
      customDomain: "api.example.com",
    };
    expect(hasConnectedDomain(svc, [])).toBe(true);
  });

  it("recognizes the default free hostname only for an exposed service", () => {
    expect(hasConnectedDomain(baseService, [])).toBe(true);
    expect(hasConnectedDomain({ ...baseService, exposed: false }, [])).toBe(false);
  });

  it("returns false when custom domainType is selected but customDomain is blank and no domains exist", () => {
    const svc: Service = {
      ...baseService,
      domainType: "custom",
      customDomain: "",
    };
    expect(hasConnectedDomain(svc, [])).toBe(false);
  });
});

describe("shouldWarnAboutUnreachableServices", () => {
  const serviceWithPorts: Service = {
    id: "svc_proxy",
    name: "proxy",
    kind: "compose",
    image: "proxy:latest",
    build: null,
    dockerfile: null,
    buildArgs: null,
    ports: ["20020:9000"],
    dependsOn: [],
    environment: {},
    volumes: [],
    command: null,
    restart: "unless-stopped",
    exposed: true,
    exposedPort: "9000",
    domain: "",
    customDomain: "",
    domainType: "free",
    publicEndpoints: [],
    enabled: true,
    sortOrder: 0,
  };

  const internalService: Service = {
    id: "svc_redis",
    name: "redis",
    kind: "compose",
    image: "redis:alpine",
    build: null,
    dockerfile: null,
    buildArgs: null,
    ports: [],
    dependsOn: [],
    environment: {},
    volumes: [],
    command: null,
    restart: "unless-stopped",
    exposed: false,
    exposedPort: null,
    domain: "",
    customDomain: "",
    domainType: "free",
    publicEndpoints: [],
    enabled: true,
    sortOrder: 1,
  };

  it("returns false when no services have ports", () => {
    expect(shouldWarnAboutUnreachableServices([internalService])).toBe(false);
  });

  it("does NOT warn when candidate service has an active domain in domain table", () => {
    const domains = [
      { id: "dom_1", serviceId: "svc_proxy", hostname: "archive.rschl.de", targetPort: 9000 },
    ];
    expect(shouldWarnAboutUnreachableServices([serviceWithPorts, internalService], domains)).toBe(
      false,
    );
  });

  it("warns when candidate service is unexposed and has no domains", () => {
    const unexposed = { ...serviceWithPorts, exposed: false };
    expect(shouldWarnAboutUnreachableServices([unexposed, internalService], [])).toBe(true);
  });
});
