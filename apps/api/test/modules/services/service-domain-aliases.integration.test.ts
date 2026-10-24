import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ edge: vi.fn(), freeGate: vi.fn() }));
vi.mock("@repo/platform/engine/lib/platform-config", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/platform-config")>()),
  platform: () => ({ runtime: { name: "docker" } }),
}));
vi.mock("@repo/platform/engine/lib/route-apply.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/route-apply.service")>()),
  reconcileProjectRoutes: h.edge,
}));
vi.mock("@repo/platform/engine/lib/free-domain-guard", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/free-domain-guard")>()),
  assertFreeEndpointsAllowed: h.freeGate,
}));
vi.mock("@repo/platform/engine/modules/domains/domain.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/domains/domain.service")>()),
  reuseServerCertForDomain: vi.fn().mockResolvedValue(false),
}));

import { repos, seedOwner } from "../jobs/_harness";
import { updateService } from "@repo/platform/engine/modules/services/service.service";
import type { ServicePublicEndpoint } from "@repo/db";

beforeEach(() => {
  vi.clearAllMocks();
  h.edge.mockReset().mockResolvedValue(undefined);
  h.freeGate.mockReset().mockResolvedValue(undefined);
});

async function seed() {
  const actor = await seedOwner();
  const group = await repos.projectGroup.create({
    organizationId: actor.orgId,
    name: "Aliases",
    slug: actor.orgId,
  });
  const project = await repos.project.create({
    organizationId: actor.orgId,
    groupId: group.id,
    name: "Web",
    slug: actor.orgId,
  });
  const label = project.id.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const primary = `${label}.example.com`;
  const alias = `alias-${label}.example.com`;
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
    domainType: "custom",
    customDomain: primary,
    publicEndpoints: endpoints,
  });
  const domain = await repos.domain.create({
    projectId: project.id,
    serviceId: service.id,
    hostname: primary,
    targetPort: 4000,
    domainType: "custom",
    isPrimary: true,
    verified: true,
    status: "active",
    sslStatus: "active",
  });
  const storedDomain = (await repos.domain.findById(domain.id))!;
  return {
    ctx: { organizationId: actor.orgId, userId: actor.userId } as never,
    project,
    service,
    domain: storedDomain,
    primary,
    alias,
    endpoints,
  };
}

describe("same-port service domains with real persistence", () => {
  it("adds an alias without removing the verified primary and removes only the chosen alias", async () => {
    const s = await seed();
    const routes: ServicePublicEndpoint[] = [
      ...s.endpoints,
      { port: 4000, domainType: "custom", customDomain: s.alias },
    ];
    await updateService(s.ctx, s.project.id, s.service.id, { publicEndpoints: routes });
    expect(await repos.service.findById(s.service.id)).toMatchObject({
      exposedPort: "4000",
      customDomain: s.primary,
      publicEndpoints: routes,
    });
    expect(await repos.domain.findById(s.domain.id)).toEqual(s.domain);
    expect(await repos.domain.findByHostname(s.alias)).toMatchObject({
      projectId: s.project.id,
      serviceId: s.service.id,
      targetPort: 4000,
      verified: false,
    });
    const apply = h.edge.mock.calls.at(-1)?.[1];
    expect(apply?.registers.map((route: { hostname: string }) => route.hostname)).toEqual([
      s.primary,
      s.alias,
    ]);
    expect(apply?.removes).toEqual([]);

    await updateService(s.ctx, s.project.id, s.service.id, {
      publicEndpoints: [routes[1]!, routes[0]!],
    });
    expect(await repos.service.findById(s.service.id)).toMatchObject({
      customDomain: s.alias,
      publicEndpoints: [routes[1]!, routes[0]!],
    });
    expect(await repos.domain.findById(s.domain.id)).toEqual(s.domain);
    expect(h.edge.mock.calls.at(-1)?.[1].removes).toEqual([]);

    await updateService(s.ctx, s.project.id, s.service.id, { publicEndpoints: s.endpoints });
    expect(await repos.domain.findByHostname(s.alias)).toBeUndefined();
    expect(await repos.domain.findById(s.domain.id)).toEqual(s.domain);
    expect(h.edge.mock.calls.at(-1)?.[1].removes).toEqual([
      { hostname: s.alias, isCustomDomain: true },
    ]);
  });

  it("refuses a gated alias before changing service configuration or domain rows", async () => {
    const s = await seed();
    const before = await repos.service.findById(s.service.id);
    const alias = `alias-${s.primary.split(".")[0]}`;
    h.freeGate.mockRejectedValueOnce(new Error("Cloud connection required"));
    await expect(
      updateService(s.ctx, s.project.id, s.service.id, {
        publicEndpoints: [...s.endpoints, { port: 4000, domainType: "free", domain: alias }],
      }),
    ).rejects.toThrow("Cloud connection required");
    expect(await repos.service.findById(s.service.id)).toEqual(before);
    expect(await repos.domain.listByProject(s.project.id)).toEqual([s.domain]);
    expect(h.edge).not.toHaveBeenCalled();
    expect(h.freeGate.mock.calls.at(-1)?.[1]).toEqual([
      { port: 4000, domainType: "free", domain: alias },
    ]);
  });

  it("keeps the complete saved configuration and old domain when edge application fails", async () => {
    const s = await seed();
    const routes: ServicePublicEndpoint[] = [
      ...s.endpoints,
      { port: 4000, domainType: "custom", customDomain: s.alias },
    ];
    h.edge.mockRejectedValueOnce(new Error("Edge temporarily unavailable"));
    await updateService(s.ctx, s.project.id, s.service.id, { publicEndpoints: routes });
    expect((await repos.service.findById(s.service.id))?.publicEndpoints).toEqual(routes);
    expect(await repos.domain.findById(s.domain.id)).toEqual(s.domain);
    expect(h.edge.mock.calls.at(-1)?.[1].removes).toEqual([]);
  });
});

it("persists a portless www redirect and registers it through the shared route path", async () => {
  const s = await seed();
  const redirect = { domainType: "custom" as const, customDomain: s.alias, redirectTo: s.primary, redirectStatus: 301 as const };
  await updateService(s.ctx, s.project.id, s.service.id, { publicEndpoints: [...s.endpoints, redirect] });
  const stored = (await repos.service.findById(s.service.id))!;
  expect(stored.publicEndpoints).toEqual([...s.endpoints, redirect]);
  expect(await repos.domain.findByHostname(s.alias)).toMatchObject({ serviceId: s.service.id, redirectTo: s.primary, redirectStatus: 301 });
  expect(h.edge.mock.calls.at(-1)?.[1].registers).toEqual(expect.arrayContaining([
    expect.objectContaining({ hostname: s.alias, redirectHost: { target: s.primary, statusCode: 301 } }),
  ]));
  const { buildServiceRouteDomains } = await import("@repo/platform/engine/lib/routing-domains");
  for (const runtimeName of ["docker", "cloud-docker"]) {
    const planned = buildServiceRouteDomains({ project: s.project, service: stored, runtimeName, usesManagedRouting: true });
    expect(planned.find(route => route.hostname === s.alias)).toMatchObject({ redirectTo: s.primary, redirectStatus: 301 });
  }
  // Editing to "serve app" clears both saved intent and the derived Domain row.
  h.edge.mockClear();
  await updateService(s.ctx, s.project.id, s.service.id, { publicEndpoints: [
    ...s.endpoints, { ...redirect, port: 4000, redirectTo: "" },
  ] });
  expect(await repos.domain.findByHostname(s.alias)).toMatchObject({ redirectTo: null, redirectStatus: null });
  expect(h.edge.mock.calls.at(-1)?.[1].registers.find((route: { hostname: string }) => route.hostname === s.alias)).not.toHaveProperty("redirectHost");
});

it.each(["foreign", "self", "cycle", "invalid status"])("rejects %s redirects before service or domain writes", async kind => {
  const s = await seed();
  const endpoints = [
    ...structuredClone(s.endpoints),
    { domainType: "custom" as const, customDomain: s.alias, redirectTo: kind === "foreign" ? "outside.example.com" : kind === "self" ? s.alias : s.primary, redirectStatus: kind === "invalid status" ? 200 : 301 },
  ];
  if (kind === "cycle") Object.assign(endpoints[0], { redirectTo: s.alias });
  await expect(updateService(s.ctx, s.project.id, s.service.id, { publicEndpoints: endpoints } as never)).rejects.toThrow();
  expect((await repos.service.findById(s.service.id))!.publicEndpoints).toEqual(s.endpoints);
  expect(await repos.domain.findByHostname(s.alias)).toBeUndefined();
  expect(h.edge).not.toHaveBeenCalled();
});

it("preserves a legacy API redirect during unrelated service route edits", async () => {
  const s = await seed();
  await repos.domain.create({ projectId: s.project.id, serviceId: s.service.id, hostname: s.alias,
    domainType: "custom", redirectTo: s.primary, redirectStatus: 308 });
  const routes = [...s.endpoints, { ...s.endpoints[0]!, customDomain: s.alias }];
  await repos.service.update(s.service.id, { publicEndpoints: routes });
  await updateService(s.ctx, s.project.id, s.service.id, { exposed: true });
  expect(await repos.domain.findByHostname(s.alias)).toMatchObject({ redirectTo: s.primary, redirectStatus: 308 });
  expect(h.edge.mock.calls.at(-1)?.[1].registers).toEqual(expect.arrayContaining([
    expect.objectContaining({ hostname: s.alias, redirectHost: { target: s.primary, statusCode: 308 } }),
  ]));
});
