import { createConfigurationSecrets } from "../configuration-secrets";
import { createEncryption } from "../encryption";
import { describe, expect, it } from "vitest";
import {
  composeWritePatch,
  createServiceRepo,
  isComposeProvenanceUpgrade,
  normalizeRoutingFields,
  toComposeSpec,
} from "./service.repo";
import type { Database } from "../client";

const testEncryption = createEncryption("repository-test-secret");
const configuration = createConfigurationSecrets(testEncryption);

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
          writes.push(configuration.openService(data));
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;

    await createServiceRepo(db, testEncryption).reconcileFromCompose("proj_1", [
      { name: "backend", image: "convex:2" },
    ]);

    expect(writes).toHaveLength(1);
    expect(writes[0].image).toBe("convex:2");
    expect(writes[0].publicEndpoints).toEqual(multiRoute);
    expect(writes[0].exposed).toBe(true);
  });
});

describe("reconcileFromCompose bootstraps dynamic env provenance (#673)", () => {
  it("restores known expressions and preserves an ambiguous legacy value for review", async () => {
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
          writes.push(configuration.openService(data));
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;

    await createServiceRepo(db, testEncryption).reconcileFromCompose("proj_1", [
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
      environmentTemplateKeys: ["DATABASE_URL"],
    });
    expect(writes[0].importedSpec).toBeNull();
    expect(writes[0].driftSpec).toBeTruthy();
  });
});

describe("legacy compose provenance baselines", () => {
  const oldBaseline = {
    name: "api",
    image: "example/api:1",
    environment: { PORT: "3000", NODE_ENV: "production" },
    advanced: { healthcheck: { test: ["CMD", "true"] } },
  };
  const parsedNow = {
    ...oldBaseline,
    environment: { PORT: "${PORT:-3000}", NODE_ENV: "${NODE_ENV:-production}" },
    advanced: {
      ...oldBaseline.advanced,
      environmentTemplateKeys: ["PORT", "NODE_ENV"],
      buildArgTemplateKeys: [],
    },
  };

  it("recognizes parser metadata as an upgrade instead of a repo edit", () => {
    expect(isComposeProvenanceUpgrade(oldBaseline, parsedNow)).toBe(true);
  });

  it("does not hide a real compose change that arrived with the metadata", () => {
    expect(isComposeProvenanceUpgrade(oldBaseline, { ...parsedNow, image: "example/api:2" })).toBe(
      false,
    );
  });

  it("restores unchanged source expressions while preserving live operator edits", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: {
        service: {
          findMany: async () => [
            {
              id: "svc_1",
              projectId: "proj_1",
              kind: "compose",
              ...oldBaseline,
              environment: { PORT: "20011", NODE_ENV: "production" },
              importedSpec: oldBaseline,
              driftSpec: { image: "stale" },
            },
          ],
        },
      },
      update: () => ({
        set: (data: Record<string, unknown>) => {
          writes.push(configuration.openService(data));
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;

    const result = await createServiceRepo(db, testEncryption).reconcileFromCompose("proj_1", [parsedNow]);

    expect(result.driftedNames).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ importedSpec: toComposeSpec(parsedNow), driftSpec: null });
    expect(writes[0].environment).toEqual({ PORT: "20011", NODE_ENV: "${NODE_ENV:-production}" });
    expect(writes[0].advanced).toMatchObject({
      environmentTemplateKeys: ["NODE_ENV"], environmentOverrideKeys: ["PORT"],
    });
  });

  it("does not attach new image provenance to an image the operator already changed", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const parsedWithImageTemplate = {
      ...oldBaseline,
      advanced: {
        ...oldBaseline.advanced,
        imageTemplate: {
          expression: "example/api:${VERSION:-1}",
          unresolvedVariables: [],
        },
      },
    };
    const db = {
      query: {
        service: {
          findMany: async () => [
            {
              id: "svc_1",
              projectId: "proj_1",
              kind: "compose",
              ...oldBaseline,
              image: "registry.example.com/acme/api:manual",
              importedSpec: oldBaseline,
              driftSpec: null,
            },
          ],
        },
      },
      update: () => ({
        set: (data: Record<string, unknown>) => {
          writes.push(configuration.openService(data));
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;

    await createServiceRepo(db, testEncryption).reconcileFromCompose("proj_1", [parsedWithImageTemplate]);

    expect(writes).toHaveLength(1);
    expect(writes[0].advanced).toEqual(oldBaseline.advanced);
    expect(writes[0]).toMatchObject({
      importedSpec: toComposeSpec(parsedWithImageTemplate),
      driftSpec: null,
    });
  });
});

describe("Compose image provenance (#809)", () => {
  const stored = {
    image: "ghcr.io/acme/api:1.0.0",
    advanced: {
      imageTemplate: {
        expression: "ghcr.io/acme/api:${MY_VERSION}",
        unresolvedVariables: [],
      },
      readiness: { enabled: true },
    },
  };

  it("preserves the source expression when a parser-owned image is replayed", () => {
    const patch = composeWritePatch(
      {
        name: "api",
        image: "ghcr.io/acme/api:2.0.0",
        advanced: {
          imageTemplate: {
            expression: "ghcr.io/acme/api:${MY_VERSION}",
            unresolvedVariables: [],
          },
        },
      },
      stored,
    );

    expect(patch.advanced).toMatchObject({
      readiness: { enabled: true },
      imageTemplate: { expression: "ghcr.io/acme/api:${MY_VERSION}" },
    });
  });

  it("clears stale source provenance when the image is a literal override", () => {
    const patch = composeWritePatch(
      { name: "api", image: "registry.example.com/acme/api:manual" },
      stored,
    );

    expect(patch.image).toBe("registry.example.com/acme/api:manual");
    expect(patch.advanced).toEqual({ readiness: { enabled: true } });
  });

  it("does not graft a newer expression onto an old literal rollback snapshot", () => {
    const patch = composeWritePatch({ name: "api", image: stored.image }, stored);

    expect(patch.image).toBe(stored.image);
    expect(patch.advanced).toEqual({ readiness: { enabled: true } });
  });

  it("records an authoritative import baseline so later literal edits have clear ownership", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const row = {
      id: "svc_1",
      projectId: "proj_1",
      name: "api",
      kind: "compose",
      image: stored.image,
      advanced: stored.advanced,
      exposed: false,
      importedSpec: null,
      driftSpec: null,
    };
    const db = {
      query: { service: { findMany: async () => [row] } },
      update: () => ({
        set: (data: Record<string, unknown>) => ({
          where: async () => writes.push(configuration.openService(data)),
        }),
      }),
    } as unknown as Database;
    const parsed = {
      name: "api",
      image: stored.image,
      advanced: stored.advanced,
    };

    await createServiceRepo(db, testEncryption).syncFromCompose("proj_1", [parsed], {
      removeMissing: false,
      composeAuthoritative: true,
    });

    expect(writes[0]).toMatchObject({
      importedSpec: toComposeSpec(parsed),
      driftSpec: null,
    });
  });

  it("repairs an untouched legacy scan without taking ownership of a manual image", async () => {
    const reconcile = async (image: string) => {
      const writes: Array<Record<string, unknown>> = [];
      const row = {
        id: "svc_1",
        projectId: "proj_1",
        name: "api",
        kind: "compose",
        image,
        buildArgs: {},
        environment: {},
        advanced: { readiness: { enabled: true } },
        exposed: false,
        importedSpec: null,
        driftSpec: null,
      };
      const db = {
        query: { service: { findMany: async () => [row] } },
        update: () => ({
          set: (data: Record<string, unknown>) => ({
            where: async () => writes.push(configuration.openService(data)),
          }),
        }),
      } as unknown as Database;
      const parsed = {
        name: "api",
        image: "ghcr.io/acme/api:2.0.0",
        advanced: {
          imageTemplate: {
            expression: "ghcr.io/acme/api:${MY_VERSION}",
            unresolvedVariables: [],
            sourceValue: "ghcr.io/acme/api:",
          },
        },
      };

      await createServiceRepo(db, testEncryption).reconcileFromCompose("proj_1", [parsed]);
      return writes[0];
    };

    const untouched = await reconcile("ghcr.io/acme/api:");
    expect(untouched.advanced).toMatchObject({
      readiness: { enabled: true },
      imageTemplate: { expression: "ghcr.io/acme/api:${MY_VERSION}" },
    });

    const manual = await reconcile("registry.example.com/acme/api:pinned");
    expect(manual.advanced).toEqual({
      readiness: { enabled: true },
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
          writes.push(configuration.openService(data));
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;

    await createServiceRepo(db, testEncryption).reconcileFromCompose("proj_1", [
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
            writes.push(configuration.openService(data));
            return { where: async () => undefined };
          },
        }),
      } as unknown as Database;

      await createServiceRepo(db, testEncryption).reconcileFromCompose("proj_1", [
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
        buildArgTemplateKeys: expectedTemplateKeys,
      });
      expect((writes[0].importedSpec as Record<string, unknown>).buildArgs).toEqual({
        APP_PACKAGE: "@myorg/api",
      });
    },
  );
});
