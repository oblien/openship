import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ edge: vi.fn(), apply: vi.fn(), freeGate: vi.fn() }));
vi.mock("@repo/platform/engine/lib/platform-config", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/platform-config")>()),
  platform: () => ({ runtime: { name: "docker" }, target: "local" }),
}));
vi.mock("@repo/platform/engine/lib/route-apply.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/route-apply.service")>()),
  reconcileProjectRoutes: h.edge,
}));
vi.mock("@repo/platform/engine/modules/domains/routing-apply.service", async (original) => ({
  ...(await original<
    typeof import("@repo/platform/engine/modules/domains/routing-apply.service")
  >()),
  applyProjectRouting: h.apply,
}));
vi.mock("@repo/platform/engine/lib/free-domain-guard", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/free-domain-guard")>()),
  assertFreeEndpointsAllowed: h.freeGate,
}));
vi.mock("@repo/platform/engine/lib/server-target", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/server-target")>()),
  resolveProjectServerHost: vi.fn().mockResolvedValue("203.0.113.10"),
  resolveInstancePublicIp: vi.fn().mockResolvedValue(null),
}));
vi.mock("@repo/platform/engine/lib/edge-orphans.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/edge-orphans.service")>()),
  untrackedSiteFor: vi.fn().mockResolvedValue(null),
}));
vi.mock("@repo/platform/engine/modules/dns/dns-credential.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/dns/dns-credential.service")>()),
  releaseRecords: vi.fn().mockResolvedValue({ deleted: 0 }),
}));
vi.mock("@repo/platform/engine/lib/managed-edge-proxy", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/managed-edge-proxy")>()),
  releaseManagedHostnames: vi.fn().mockResolvedValue({ failures: [] }),
}));
vi.mock("@repo/platform/engine/modules/domains/domain.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/domains/domain.service")>()),
  reuseServerCertForDomain: vi.fn().mockResolvedValue(false),
}));

import { repos, seedOwner } from "../jobs/_harness";
import {
  addDomain,
  removeDomain,
  updateDomain,
} from "@repo/platform/engine/modules/domains/domain.service";
import { updateService } from "@repo/platform/engine/modules/services/service.service";
import {
  buildProjectRouteDomains,
  buildServiceRouteDomains,
} from "@repo/platform/engine/lib/routing-domains";
import { resolveDomainFanoutRoutes } from "@repo/platform/engine/modules/deployments/compose/composite-route";
import { syncProjectPublicRoutes } from "@repo/platform/engine/lib/project-route-store";
import { withProjectRuntimeLock } from "@repo/platform/engine/lib/project-runtime-lock";
import { Hono } from "hono";
import { OpenshipClient } from "@repo/sdk/client";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { domainRoutes } from "../../../src/modules/domains/domain.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import type { ServicePublicEndpoint } from "@repo/db";

beforeEach(() => {
  vi.clearAllMocks();
  h.edge.mockReset().mockResolvedValue(undefined);
  h.apply.mockReset().mockResolvedValue(undefined);
  h.freeGate.mockReset().mockResolvedValue(undefined);
});

async function seedProject(orgId: string, name: string) {
  const group = await repos.projectGroup.create({
    organizationId: orgId,
    name,
    slug: `${orgId}-${name}`,
  });
  const project = await repos.project.create({
    organizationId: orgId,
    groupId: group.id,
    name,
    slug: `${orgId}-${name}`,
  });
  const label = project.id.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const primary = `${label}.example.com`;
  const endpoints: ServicePublicEndpoint[] = [
    { port: 4000, domainType: "custom", customDomain: primary },
  ];
  const service = await repos.service.create({
    projectId: project.id,
    name: "web",
    kind: "compose",
    image: "nginx:alpine",
    enabled: true,
    exposed: true,
    exposedPort: "4000",
    ports: ["4000", "9000"],
    domainType: "custom",
    customDomain: primary,
    publicEndpoints: endpoints,
  });
  await repos.domain.create({
    projectId: project.id,
    serviceId: service.id,
    hostname: primary,
    targetPort: 4000,
    domainType: "custom",
    isPrimary: true,
    verified: true,
    status: "active",
  });
  return { project, service, label, primary, endpoints };
}

async function seed() {
  const actor = await seedOwner();
  const ctx = { organizationId: actor.orgId, userId: actor.userId } as never;
  return {
    ctx,
    ...(await seedProject(actor.orgId, "tenants")),
    other: await seedProject(actor.orgId, "other"),
  };
}

async function plannedHostnames(projectId: string, serviceId: string) {
  const project = (await repos.project.findById(projectId))!;
  const service = (await repos.service.findById(serviceId))!;
  const rows = await repos.domain.listByProject(projectId);
  return buildServiceRouteDomains({
    project,
    service,
    runtimeName: "docker",
    usesManagedRouting: true,
    domainByHostname: new Map(rows.map((row) => [row.hostname, row])),
  }).map((route) => [route.hostname, route.targetPort]);
}

describe("domain rows bound to a service", () => {
  it("routes 25 tenant domains from their rows without touching publicEndpoints", async () => {
    const s = await seed();
    const before = await repos.service.findById(s.service.id);
    const tenants = Array.from({ length: 25 }, (_, i) => `t${i}-${s.label}.example.org`);
    for (const hostname of tenants) {
      const { domain } = await addDomain(s.ctx, {
        projectId: s.project.id,
        hostname,
        serviceId: s.service.id,
      });
      expect(domain).toMatchObject({
        serviceId: s.service.id,
        targetPort: 4000,
        boundByDomain: true,
        status: "pending",
      });
    }

    expect(await repos.service.findById(s.service.id)).toEqual(before);
    const rows = await repos.domain.listByProject(s.project.id);
    expect(new Set(rows.map((row) => row.verificationToken)).size).toBe(26);
    expect(await plannedHostnames(s.project.id, s.service.id)).toEqual([
      [s.primary, 4000],
      ...[...tenants].sort().map((hostname) => [hostname, 4000]),
    ]);
    expect(h.apply).toHaveBeenCalledWith(s.project.id);
  });

  it("refuses a service of another project and a port the service does not have", async () => {
    const s = await seed();
    const hostname = `x-${s.label}.example.org`;
    await expect(
      addDomain(s.ctx, { projectId: s.project.id, hostname, serviceId: s.other.service.id }),
    ).rejects.toThrow("is not a service of this project");
    await expect(
      addDomain(s.ctx, {
        projectId: s.project.id,
        hostname,
        serviceId: s.service.id,
        targetPort: 5555,
      }),
    ).rejects.toThrow("Port 5555 is not a port of service");
    expect(await repos.domain.findByHostname(hostname)).toBeUndefined();

    const { domain } = await addDomain(s.ctx, { projectId: s.project.id, hostname });
    await expect(updateDomain(s.ctx, domain.id, { serviceId: s.other.service.id })).rejects.toThrow(
      "is not a service of this project",
    );
    expect(await repos.domain.findById(domain.id)).toMatchObject({
      serviceId: null,
      boundByDomain: false,
    });
  });

  it("keeps bound rows and their routes through publicEndpoints patches", async () => {
    const s = await seed();
    const bound = `bound-${s.label}.example.org`;
    const alias = `alias-${s.label}.example.com`;
    const { domain } = await addDomain(s.ctx, {
      projectId: s.project.id,
      hostname: bound,
      serviceId: s.service.id,
      targetPort: 9000,
    });
    const boundRow = await repos.domain.findById(domain.id);

    // A list that also names the bound hostname must not re-point it.
    await updateService(s.ctx, s.project.id, s.service.id, {
      publicEndpoints: [
        ...s.endpoints,
        { port: 4000, domainType: "custom", customDomain: alias },
        { port: 4000, domainType: "custom", customDomain: bound },
      ],
    });
    expect(await repos.domain.findById(domain.id)).toEqual(boundRow);
    expect(
      h.edge.mock.calls
        .at(-1)?.[1]
        .registers.map((r: { hostname: string; port: number }) => [r.hostname, r.port]),
    ).toEqual([
      [s.primary, 4000],
      [alias, 4000],
      [bound, 9000],
    ]);

    await updateService(s.ctx, s.project.id, s.service.id, { publicEndpoints: s.endpoints });
    expect(await repos.domain.findById(domain.id)).toEqual(boundRow);
    expect(await repos.domain.findByHostname(alias)).toBeUndefined();
    expect(h.edge.mock.calls.at(-1)?.[1].removes).toEqual([
      { hostname: alias, isCustomDomain: true },
    ]);
    expect(await plannedHostnames(s.project.id, s.service.id)).toEqual([
      [s.primary, 4000],
      [bound, 9000],
    ]);
  });

  it("unbinding and deleting remove only the domain's own route", async () => {
    const s = await seed();
    const first = `a-${s.label}.example.org`;
    const second = `b-${s.label}.example.org`;
    const a = (
      await addDomain(s.ctx, { projectId: s.project.id, hostname: first, serviceId: s.service.id })
    ).domain;
    const b = (
      await addDomain(s.ctx, { projectId: s.project.id, hostname: second, serviceId: s.service.id })
    ).domain;
    const serviceBefore = await repos.service.findById(s.service.id);

    await updateDomain(s.ctx, a.id, { serviceId: null });
    expect(h.edge.mock.calls.at(-1)?.[1].removes).toEqual([
      { hostname: first, isCustomDomain: true },
    ]);
    expect(await repos.domain.findById(a.id)).toMatchObject({
      serviceId: null,
      targetPort: null,
      boundByDomain: true,
    });
    // Unbound tenant rows must not turn into project routes on the next deploy,
    // even when the project has a static/default destination or a stale endpoint.
    const unbound = (await repos.domain.findById(a.id))!;
    for (const extras of [
      { isStatic: true },
      { defaultTargetPort: 4000 },
      {
        publicEndpoints: [{ domainType: "custom" as const, customDomain: first, port: 4000 }],
      },
    ]) {
      expect(
        buildProjectRouteDomains({
          project: s.project,
          projectDomains: [unbound],
          runtimeName: "docker",
          usesManagedRouting: true,
          ...extras,
        }),
      ).toEqual([]);
    }

    expect(
      resolveDomainFanoutRoutes({
        routes: [
          {
            hostname: first,
            isCustomDomain: true,
            rootServiceId: s.service.id,
            rootPort: 4000,
            locations: [],
          },
        ],
        services: [s.service],
        domainByHostname: new Map([[first, unbound]]),
      }),
    ).toEqual([]);

    await syncProjectPublicRoutes({ projectId: s.project.id, endpoints: [] });
    expect(await repos.domain.findById(a.id)).toMatchObject({ boundByDomain: true });

    await removeDomain(s.ctx, b.id);
    expect(h.edge.mock.calls.at(-1)?.[1].removes).toEqual([
      { hostname: second, isCustomDomain: true },
    ]);
    expect(await repos.domain.findById(b.id)).toBeUndefined();
    expect(await repos.service.findById(s.service.id)).toEqual(serviceBefore);
    expect(await plannedHostnames(s.project.id, s.service.id)).toEqual([[s.primary, 4000]]);

    // A list-derived row is not unbound from here.
    const primaryRow = (await repos.domain.findByHostname(s.primary))!;
    await expect(updateDomain(s.ctx, primaryRow.id, { serviceId: null })).rejects.toThrow(
      "public endpoints",
    );
  });
});

it("retains a tenant binding when route removal fails", async () => {
  const s = await seed();
  const { domain } = await addDomain(s.ctx, {
    projectId: s.project.id,
    hostname: `fail-${s.label}.example.org`,
    serviceId: s.service.id,
  });
  h.edge.mockRejectedValueOnce(new Error("edge unreachable"));
  await expect(updateDomain(s.ctx, domain.id, { serviceId: null })).rejects.toThrow(
    "binding was kept",
  );
  expect(await repos.domain.findById(domain.id)).toMatchObject({
    serviceId: s.service.id,
    boundByDomain: true,
  });
});

it("uses the authenticated SDK/HTTP operation and rejects foreign organizations and malformed edits", async () => {
  const actor = await seedOwner();
  const s = await seedProject(actor.orgId, "transport");
  const app = new Hono()
    .onError(handleApiError)
    .route("/api/health", healthRoutes)
    .route("/api/domains", domainRoutes);
  const client = new OpenshipClient({
    baseUrl: "http://openship.test",
    token: actor.token,
    organizationId: actor.orgId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  });
  const { domain } = await client.domains.create(s.project.id, {
    hostname: `transport-${s.label}.example.org`,
    serviceId: s.service.id,
  });
  expect(await client.domains.update(domain.id, { targetPort: 9000 })).toMatchObject({
    serviceId: s.service.id,
    targetPort: 9000,
    boundByDomain: true,
  });
  const other = await seedOwner();
  const denied = await app.request(`/api/domains/${domain.id}`, {
    method: "PATCH",
    headers: {
      ...other.auth,
      "content-type": "application/json",
      "x-organization-id": other.orgId,
    },
    body: JSON.stringify({ serviceId: null }),
  });
  expect(denied.status).toBe(404);
  const invalid = await app.request(`/api/domains/${domain.id}`, {
    method: "PATCH",
    headers: {
      ...actor.auth,
      "content-type": "application/json",
      "x-organization-id": actor.orgId,
    },
    body: JSON.stringify({ targetPort: 65536 }),
  });
  expect(invalid.status).toBe(400);
  expect(await repos.domain.findById(domain.id)).toMatchObject({ targetPort: 9000 });
});

it("rechecks the selected service after a queued binding edit acquires the project lock", async () => {
  const s = await seed();
  const { domain } = await addDomain(s.ctx, {
    projectId: s.project.id,
    hostname: `queue-${s.label}.example.org`,
  });
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = withProjectRuntimeLock(s.project.id, async () => {
    enter();
    await held;
  });
  await entered;
  const edit = updateDomain(s.ctx, domain.id, { serviceId: s.service.id });
  const result = expect(edit).rejects.toThrow("not serving public traffic");
  await repos.service.update(s.service.id, { exposed: false });
  release();
  await owner;
  await result;
  expect(await repos.domain.findById(domain.id)).toMatchObject({
    serviceId: null,
    boundByDomain: false,
  });
});

it("retains service paths while the domain row authoritatively owns and moves its root", async () => {
  const s = await seed();
  const hostname = `paths-${s.label}.example.org`;
  const { domain } = await addDomain(s.ctx, {
    projectId: s.project.id, hostname, serviceId: s.service.id,
  });
  const stored = {
    hostname, isCustomDomain: true, rootServiceId: s.service.id, rootPort: 4000,
    locations: [{ pathPrefix: "/api", serviceId: s.service.id, port: 9000 }],
  };
  const resolve = (owner: typeof domain, services: typeof s.service[]) => resolveDomainFanoutRoutes({
    routes: [stored], services, domainByHostname: new Map([[hostname, owner]]),
  });
  expect(resolve(domain, [s.service])).toEqual([stored]);
  const replacement = { ...s.service, id: "replacement", exposedPort: 9000 };
  expect(resolve({ ...domain, serviceId: replacement.id, targetPort: 9000 }, [s.service, replacement]))
    .toEqual([{ ...stored, rootServiceId: replacement.id, rootPort: 9000 }]);
  expect(resolve({ ...domain, serviceId: null, targetPort: null }, [s.service])).toEqual([]);
  expect(resolve(domain, [{ ...s.service, exposed: false }])).toEqual([]);
});
