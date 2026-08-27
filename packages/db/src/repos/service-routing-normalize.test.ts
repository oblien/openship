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

describe("reconcileFromCompose bootstraps dynamic env provenance (#673)", () => {
  it("restores raw expressions without overwriting an operator-edited value", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: {
        service: {
          findMany: async () => [
            {
              id: "svc_1",
              projectId: "proj_1",
              name: "api",
              kind: "compose",
              environment: {
                POSTGRES_PASSWORD: "manual-secret",
                DATABASE_URL: "postgresql://user:@db/app",
              },
              advanced: { readiness: { enabled: true } },
              importedSpec: null,
              driftSpec: null,
            },
          ],
        },
      },
      update: () => ({
        set: (data: Record<string, unknown>) => {
          writes.push(data);
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;

    await createServiceRepo(db).reconcileFromCompose("proj_1", [
      {
        name: "api",
        environment: {
          POSTGRES_PASSWORD: "",
          DATABASE_URL: "postgresql://user:@db/app",
        },
        environmentTemplates: {
          POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set it}",
          DATABASE_URL: "postgresql://user:${POSTGRES_PASSWORD:?set it}@db/app",
        },
        advanced: {
          environmentTemplateKeys: ["POSTGRES_PASSWORD", "DATABASE_URL"],
        },
      },
    ]);

    expect(writes).toHaveLength(1);
    expect(writes[0].environment).toEqual({
      // Different from the scan-time empty preview: preserve the user's value.
      POSTGRES_PASSWORD: "manual-secret",
      // Still equal to the partial preview: migrate it back to the raw template.
      DATABASE_URL: "postgresql://user:${POSTGRES_PASSWORD:?set it}@db/app",
    });
    expect(writes[0].advanced).toEqual({
      readiness: { enabled: true },
      environmentTemplateKeys: ["POSTGRES_PASSWORD", "DATABASE_URL"],
    });
  });
});

describe("reconcileFromCompose bootstraps legacy build args (#689)", () => {
  it("normalizes an old baseline once even when the compose file has no args", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const row = {
      id: "svc_1",
      projectId: "proj_1",
      name: "api",
      kind: "compose",
      image: "example/api:1",
      buildArgs: {},
      environment: {},
      advanced: {},
      driftSpec: null,
    };
    const oldBaseline = toComposeSpec(row) as Record<string, unknown>;
    delete oldBaseline.buildArgs;
    const db = {
      query: { service: { findMany: async () => [{ ...row, importedSpec: oldBaseline }] } },
      update: () => ({
        set: (data: Record<string, unknown>) => {
          writes.push(data);
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;

    await createServiceRepo(db).reconcileFromCompose("proj_1", [
      { name: "api", image: "example/api:1" },
    ]);

    expect(writes).toHaveLength(1);
    expect((writes[0].importedSpec as Record<string, unknown>).buildArgs).toEqual({});
    expect(writes[0].driftSpec).toBeNull();
  });

  it.each([
    {
      label: "adopts repo args for a pre-column empty row",
      stored: {},
      expected: { APP_PACKAGE: "@myorg/api" },
      expectedTemplateKeys: ["APP_PACKAGE"],
    },
    {
      label: "preserves manually stored args",
      stored: { APP_PACKAGE: "@myorg/manual" },
      expected: { APP_PACKAGE: "@myorg/manual" },
      expectedTemplateKeys: [],
    },
  ])(
    "$label before advancing a null baseline",
    async ({ stored, expected, expectedTemplateKeys }) => {
      const writes: Array<Record<string, unknown>> = [];
      const db = {
        query: {
          service: {
            findMany: async () => [
              {
                id: "svc_1",
                projectId: "proj_1",
                name: "api",
                kind: "compose",
                build: ".",
                dockerfile: "Dockerfile",
                buildArgs: stored,
                environment: {},
                advanced: {},
                importedSpec: null,
                driftSpec: null,
              },
            ],
          },
        },
        update: () => ({
          set: (data: Record<string, unknown>) => {
            writes.push(data);
            return { where: async () => undefined };
          },
        }),
      } as unknown as Database;

      await createServiceRepo(db).reconcileFromCompose("proj_1", [
        {
          name: "api",
          build: ".",
          dockerfile: "Dockerfile",
          buildArgs: { APP_PACKAGE: "@myorg/api" },
          advanced: { buildArgTemplateKeys: ["APP_PACKAGE"] },
        },
      ]);

      expect(writes).toHaveLength(1);
      expect(writes[0].buildArgs).toEqual(expected);
      expect(writes[0].advanced).toEqual({
        environmentTemplateKeys: [],
        buildArgTemplateKeys: expectedTemplateKeys,
      });
      expect((writes[0].importedSpec as Record<string, unknown>).buildArgs).toEqual({
        APP_PACKAGE: "@myorg/api",
      });
    },
  );
});
