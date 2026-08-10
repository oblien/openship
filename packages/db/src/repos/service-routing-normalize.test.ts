import { describe, expect, it } from "vitest";
import { createServiceRepo, normalizeRoutingFields, toComposeSpec } from "./service.repo";
import type { Database } from "../client";

const multiRoute = [
  { port: 3210, domainType: "free" as const, domain: "acme-backend" },
  { port: 3211, domainType: "free" as const, domain: "acme-backend-http" },
];

describe("normalizeRoutingFields", () => {
  it("pauses without erasing on an explicit exposed:false, array notwithstanding", () => {
    // `exposed:false` is authoritative over a non-empty array (which used to flip
    // the row back to exposed:true, so it could never be paused) — but the route
    // set survives, because every route reader is already gated on `exposed`.
    // Erasing it is what made an expose toggle delete a multi-route set and orphan
    // its verified domain rows, and what let a drift reconcile wipe a paused row.
    expect(normalizeRoutingFields({ exposed: false, publicEndpoints: multiRoute })).toEqual({
      exposed: false,
      exposedPort: "3210",
      domain: "acme-backend",
      customDomain: null,
      domainType: "free",
      publicEndpoints: multiRoute,
    });
  });

  it("still lets an array-only caller (no `exposed`) expose the set", () => {
    const routing = normalizeRoutingFields({ publicEndpoints: multiRoute });
    expect(routing.exposed).toBe(true);
    expect(routing.exposedPort).toBe("3210");
    expect(routing.publicEndpoints).toEqual(multiRoute);
  });

  it("round-trips a multi-route row unchanged", () => {
    const row = {
      exposed: true,
      exposedPort: "3210",
      domain: "acme-backend",
      customDomain: null,
      domainType: "free",
      publicEndpoints: multiRoute,
    };
    expect(normalizeRoutingFields(row).publicEndpoints).toEqual(multiRoute);
  });
});

/**
 * reconcileFromCompose re-normalizes the row's OWN routing when it auto-applies
 * an upstream compose change to an un-edited row. Omitting `publicEndpoints`
 * there silently dropped every secondary route on the next redeploy — routing is
 * user-owned and must survive a compose-only change.
 */
describe("reconcileFromCompose keeps the route set", () => {
  const existing = {
    id: "svc_1",
    projectId: "proj_1",
    name: "backend",
    kind: "compose",
    image: "convex:1",
    exposed: true,
    exposedPort: "3210",
    domain: "acme-backend",
    customDomain: null,
    domainType: "free",
    publicEndpoints: multiRoute,
    driftSpec: null,
  };
  // Baseline == the stored spec, so the row counts as UN-edited and the upstream
  // change auto-applies (the branch that re-normalizes routing).
  const importedSpec = toComposeSpec(existing);

  it("carries publicEndpoints through the auto-apply write", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: { service: { findMany: async () => [{ ...existing, importedSpec }] } },
      update: () => ({
        set: (data: Record<string, unknown>) => {
          writes.push(data);
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;

    await createServiceRepo(db).reconcileFromCompose("proj_1", [
      { name: "backend", image: "convex:2" },
    ]);

    expect(writes).toHaveLength(1);
    expect(writes[0].image).toBe("convex:2");
    expect(writes[0].publicEndpoints).toEqual(multiRoute);
    expect(writes[0].exposed).toBe(true);
  });
});
