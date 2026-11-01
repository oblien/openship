import { createConfigurationSecrets } from "../configuration-secrets";
import { createEncryption } from "../encryption";
import { describe, expect, it } from "vitest";
import type { Database } from "../client";
import {
  createServiceRepo,
  toComposeSpec,
  type ParsedComposeService,
  type Service,
} from "./service.repo";

const testEncryption = createEncryption("repository-test-secret");
const configuration = createConfigurationSecrets(testEncryption);

const fullEnvironment = {
  NODE_ENV: "production",
  PORT: "4000",
  BETTER_AUTH_SECRET: "legacy-auth-secret",
  GITHUB_CLIENT_SECRET: "legacy-oauth-secret",
  SMTP_HOST: "smtp.example.com",
};

function existingService(overrides: Partial<Service> = {}) {
  const compose = {
    image: "example/api:1",
    ports: ["4000"],
    environment: fullEnvironment,
    volumes: ["api_data:/data"],
  };
  return {
    id: "svc_api",
    projectId: "proj_1",
    name: "api",
    kind: "compose",
    enabled: true,
    exposed: false,
    exposedPort: null,
    domain: null,
    customDomain: null,
    domainType: "free",
    publicEndpoints: [],
    driftSpec: null,
    ...compose,
    importedSpec: toComposeSpec(compose),
    ...overrides,
  };
}

/**
 * Stateful repository seam: reconciliation uses the real createServiceRepo
 * implementation, while this tiny DB adapter records exactly what it commits.
 * It is intentionally stateful because reconcileFromCompose re-reads services
 * at the end; a write that only looked safe in its payload must also leave the
 * final stored row safe.
 */
function harness(initial = existingService(), hasScopedEnvironment = false) {
  let stored = structuredClone(initial);
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    transaction: async (run: (tx: Database) => Promise<unknown>) => run(db),
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({
      for: async () => [{ deletionInProgress: false, cloudPromotion: null }],
    }) }) }) }),
    query: {
      service: { findMany: async () => [stored] },
      envVar: { findFirst: async () => (hasScopedEnvironment ? { id: "env_saved" } : undefined) },
    },
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            writes.push(configuration.openService(data));
            stored = { ...stored, ...data };
            return [stored];
          },
        }),
      }),
    }),
  } as unknown as Database;
  return {
    repo: createServiceRepo(db, testEncryption),
    writes,
    stored: () => configuration.openService(stored),
  };
}

describe("Compose environment deletion safety", () => {
  it("preserves every stored value when an untouched service loses some repo keys", async () => {
    const h = harness();
    const proposed = {
      name: "api",
      image: "example/api:1",
      ports: ["4000"],
      environment: { NODE_ENV: "production", PORT: "4000" },
      volumes: ["api_data:/data"],
    };

    const result = await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(result.driftedNames).toEqual([]);
    expect(h.stored().environment).toEqual(fullEnvironment);
    expect(h.stored().importedSpec).toEqual(toComposeSpec(proposed));
    expect(h.stored().driftSpec).toBeNull();
  });

  it("preserves every stored value when the repo removes the entire environment block", async () => {
    const h = harness();
    const proposed = {
      name: "api",
      image: "example/api:1",
      ports: ["4000"],
      volumes: ["api_data:/data"],
    };

    await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(h.stored().environment).toEqual(fullEnvironment);
    expect(h.stored().driftSpec).toBeNull();
  });

  it("applies unrelated image, port, and volume changes while retaining omitted values", async () => {
    const h = harness();
    const proposed = {
      name: "api",
      image: "example/api:2",
      ports: ["5000"],
      environment: { NODE_ENV: "production" },
      volumes: ["new_data:/data"],
    };

    await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(h.stored()).toMatchObject({
      image: "example/api:2",
      ports: ["5000"],
      volumes: ["new_data:/data"],
      environment: fullEnvironment,
      driftSpec: null,
    });
  });

  it("protects deleted keys when the operator also edited another value", async () => {
    const editedEnvironment = { ...fullEnvironment, PORT: "4400" };
    const h = harness(existingService({ environment: editedEnvironment }));
    const { SMTP_HOST: _removed, ...withoutSmtp } = fullEnvironment;
    const proposed = {
      name: "api",
      image: "example/api:2",
      ports: ["4000"],
      environment: withoutSmtp,
      volumes: ["api_data:/data"],
    };

    await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(h.stored().environment).toEqual(editedEnvironment);
    expect(h.stored().driftSpec).toBeNull();
  });

  it("clears an old approval banner once without churning subsequent refreshes", async () => {
    const proposed: ParsedComposeService = {
      name: "api",
      image: "example/api:1",
      ports: ["4000"],
      environment: { NODE_ENV: "production" },
      volumes: ["api_data:/data"],
    };
    const h = harness(existingService({ driftSpec: toComposeSpec(proposed) }));

    const result = await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(result.driftedNames).toEqual([]);
    await h.repo.reconcileFromCompose("proj_1", [proposed]);
    expect(h.writes).toHaveLength(1);
    expect(h.stored().driftSpec).toBeNull();
    expect(h.stored().environment).toEqual(fullEnvironment);
  });

  it("continues auto-applying additions and rotations when no key is removed", async () => {
    const h = harness();
    const proposed = {
      name: "api",
      image: "example/api:2",
      ports: ["4000"],
      environment: {
        ...fullEnvironment,
        BETTER_AUTH_SECRET: "rotated",
        NEW_KEY: "added",
      },
      volumes: ["api_data:/data"],
    };

    const result = await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(result.driftedNames).toEqual([]);
    expect(h.stored()).toMatchObject({
      image: "example/api:2",
      environment: proposed.environment,
      importedSpec: toComposeSpec(proposed),
      driftSpec: null,
    });
  });

  it("keeps legacy values while bootstrapping a missing baseline", async () => {
    const h = harness(existingService({ importedSpec: null }));
    const proposed = {
      name: "api",
      image: "example/api:2",
      environment: { NODE_ENV: "production" },
    };

    await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(h.stored().environment).toEqual(fullEnvironment);
    expect(h.stored().importedSpec).toEqual(toComposeSpec(proposed));
    expect(h.stored().driftSpec).toBeNull();
  });
});


describe("Compose cached environment recovery (#893)", () => {
  const source = (value = "B") => ({
    name: "api", image: "example/api:1",
    environment: { MY_VAR: value },
    environmentTemplates: { MY_VAR: "${MY_VAR}" },
  });
  const row = (overrides: Partial<Service> = {}) =>
    existingService({
      ports: [],
      volumes: [],
      environment: { MY_VAR: "A" },
      importedSpec: null,
      ...overrides,
    });

  it("preserves an ambiguous legacy value as an override across repeated refreshes", async () => {
    const h = harness(row());
    for (const value of ["B", "C"]) {
      const result = await h.repo.reconcileFromCompose("proj_1", [source(value)]);
      expect(result.unresolvedEnvironment).toEqual([]);
      expect(result.driftedNames).toEqual([]);
      expect(h.stored().environment).toEqual({ MY_VAR: "A" });
      expect(h.stored().advanced?.environmentOverrideKeys).toEqual(["MY_VAR"]);
      expect(h.stored().importedSpec).toEqual(toComposeSpec(source(value)));
      expect(h.stored().driftSpec).toBeNull();
    }
  });

  it("restores an untouched old-baseline value even after the project value changes", async () => {
    const h = harness(row({
      importedSpec: toComposeSpec({ image: "example/api:1", environment: { MY_VAR: "A" } }),
    }));
    for (const value of ["B", "C"]) {
      const result = await h.repo.reconcileFromCompose("proj_1", [source(value)]);
      expect(result.unresolvedEnvironment).toEqual([]);
      expect(h.stored().environment).toEqual({ MY_VAR: "${MY_VAR}" });
      expect(h.stored().advanced?.environmentTemplateKeys).toEqual(["MY_VAR"]);
      expect(h.stored().driftSpec).toBeNull();
    }
    expect(h.writes).toHaveLength(1);
  });

  it("preserves a proven inline edit while upgrading an older baseline", async () => {
    const h = harness(row({
      environment: { MY_VAR: "manual" },
      importedSpec: toComposeSpec({ image: "example/api:1", environment: { MY_VAR: "A" } }),
    }));
    await h.repo.reconcileFromCompose("proj_1", [source()]);
    expect(h.stored().environment).toEqual({ MY_VAR: "manual" });
    expect(h.stored().advanced).toMatchObject({
      environmentTemplateKeys: [], environmentOverrideKeys: ["MY_VAR"],
    });
    expect((await h.repo.reconcileFromCompose("proj_1", [source("C")])).unresolvedEnvironment).toEqual([]);
  });

  it("repairs an already-poisoned baseline once without losing its value", async () => {
    const h = harness(
      row({
        advanced: { environmentTemplateKeys: ["MY_VAR"] },
        importedSpec: toComposeSpec(source()),
      }),
    );
    for (let i = 0; i < 2; i++) {
      expect(
        (await h.repo.reconcileFromCompose("proj_1", [source()])).unresolvedEnvironment,
      ).toEqual([]);
      expect(h.stored().environment).toEqual({ MY_VAR: "A" });
    }
    expect(h.writes).toHaveLength(1);
  });

  it("applies other repo fields while preserving ambiguous legacy values", async () => {
    const h = harness(
      row({
        advanced: { environmentTemplateKeys: ["MY_VAR"] },
        importedSpec: toComposeSpec(source()),
      }),
    );
    const proposed = { ...source(), image: "example/api:2" };
    const result = await h.repo.reconcileFromCompose("proj_1", [proposed]);
    expect(result.unresolvedEnvironment).toEqual([]);
    expect(h.stored().image).toBe("example/api:2");
    expect(h.stored().driftSpec).toBeNull();
  });

  it("preserves both explicit edits and legacy values without an approval gate", async () => {
    const h = harness(
      row({
        environment: { MY_VAR: "A", PINNED: "manual" },
        advanced: { environmentOverrideKeys: ["PINNED"] },
      }),
    );
    const result = await h.repo.reconcileFromCompose("proj_1", [
      {
        ...source(),
        environment: { MY_VAR: "B", PINNED: "new" },
        environmentTemplates: { MY_VAR: "${MY_VAR}", PINNED: "${PINNED}" },
      },
    ]);
    expect(result.unresolvedEnvironment).toEqual([]);
    expect(h.stored().environment).toEqual({ MY_VAR: "A", PINNED: "manual" });
  });

  it("retains explicit deletions and known kept templates on later refreshes", async () => {
    const environments: Record<string, string>[] = [{}, { MY_VAR: "${OLD_VAR}" }];
    for (const environment of environments) {
      const h = harness(
        row({
          environment,
          importedSpec: toComposeSpec(source()),
          advanced: { environmentOverrideKeys: ["MY_VAR"], environmentTemplateKeys: ["MY_VAR"] },
        }),
      );
      expect(
        (await h.repo.reconcileFromCompose("proj_1", [source()])).unresolvedEnvironment,
      ).toEqual([]);
      expect(h.stored().environment).toEqual(environment);
      expect(h.stored().advanced?.environmentTemplateKeys).toEqual(Object.keys(environment));
    }
  });
});

describe("independent Compose updates", () => {
  it("preserves a literal build argument pin when its template marker was explicitly cleared", async () => {
    const base = toComposeSpec({
      buildArgs: { TARGET: "$HOME", RELEASE: "1" },
      advanced: { buildArgTemplateKeys: ["TARGET"] },
    });
    const h = harness(
      existingService({ ...base, importedSpec: base, advanced: { buildArgTemplateKeys: [] } }),
    );
    await h.repo.reconcileFromCompose("proj_1", [
      {
        name: "api",
        buildArgs: { TARGET: "${NEW_HOME}", RELEASE: "2" },
        advanced: { buildArgTemplateKeys: ["TARGET"] },
      },
    ]);
    expect(h.stored().buildArgs).toEqual({ TARGET: "$HOME", RELEASE: "2" });
    expect(h.stored().advanced?.buildArgTemplateKeys).toEqual([]);
  });
  it.each(["inline", "scoped"])(
    "does not cascade-delete %s environment when a service is omitted upstream",
    async (scope) => {
      const base = toComposeSpec({ environment: scope === "inline" ? { TOKEN: "saved" } : {} });
      const h = harness(existingService({ ...base, importedSpec: base }), scope === "scoped");
      const result = await h.repo.reconcileFromCompose("proj_1", []);
      expect(result.services).toHaveLength(1);
      expect(h.writes).toEqual([]);
      expect(h.stored().environment).toEqual(base.environment);
    },
  );
  it("updates repo values and build args while preserving explicit overrides and UI settings", async () => {
    const base = toComposeSpec({
      image: "example/api:1",
      environment: { TOKEN: "repo-token", LOG_LEVEL: "info" },
      buildArgs: { CHANNEL: "stable", VERSION: "1" },
      advanced: { resources: { cpuCores: 1, memoryMb: 512 } },
    });
    const h = harness(
      existingService({
        ...base,
        importedSpec: base,
        environment: { TOKEN: "saved-token", LOG_LEVEL: "info", EXTRA: "saved-extra" },
        buildArgs: { CHANNEL: "private", VERSION: "1" },
        advanced: {
          ...base.advanced,
          environmentOverrideKeys: ["TOKEN"],
          resources: { cpuCores: 2, memoryMb: 512 },
          readiness: { enabled: true },
        },
      }),
    );
    const next = {
      name: "api",
      image: "example/api:2",
      environment: { TOKEN: "new-repo-token", LOG_LEVEL: "debug", ADDED: "new" },
      buildArgs: { CHANNEL: "upstream", VERSION: "2" },
      advanced: { resources: { cpuCores: 3, memoryMb: 1024 } },
    };
    for (let i = 0; i < 2; i++) {
      expect((await h.repo.reconcileFromCompose("proj_1", [next])).driftedNames).toEqual([]);
      expect(h.stored()).toMatchObject({
        image: "example/api:2",
        environment: {
          TOKEN: "saved-token",
          LOG_LEVEL: "debug",
          EXTRA: "saved-extra",
          ADDED: "new",
        },
        buildArgs: { CHANNEL: "private", VERSION: "2" },
        advanced: {
          resources: { cpuCores: 2, memoryMb: 1024 },
          readiness: { enabled: true },
        },
        importedSpec: toComposeSpec(next),
        driftSpec: null,
      });
    }
    expect(h.writes).toHaveLength(1);
  });

  it.each(["", "partial-token="])(
    "retains the only saved value when the new source resolves to %j",
    async (preview) => {
      const base = toComposeSpec({ image: "example/api:1", environment: { TOKEN: "saved-token" } });
      const h = harness(existingService({ ...base, importedSpec: base }));
      const next = {
        name: "api",
        image: "example/api:2",
        environment: { TOKEN: preview, NEW_VALUE: "" },
        environmentTemplates: { TOKEN: "${TOKEN:?required}", NEW_VALUE: "${NEW_VALUE:?required}" },
        environmentMeta: { TOKEN: { required: true }, NEW_VALUE: { required: true } },
      };
      await h.repo.reconcileFromCompose("proj_1", [next]);
      expect(h.stored()).toMatchObject({
        image: "example/api:2",
        environment: { TOKEN: "saved-token", NEW_VALUE: "${NEW_VALUE:?required}" },
        advanced: { environmentOverrideKeys: ["TOKEN"], environmentTemplateKeys: ["NEW_VALUE"] },
        driftSpec: null,
      });
    },
  );

  it("does not erase an existing value when the source changes it to an empty literal", async () => {
    const base = toComposeSpec({ environment: { TOKEN: "saved-token", LOG_LEVEL: "info" } });
    const h = harness(existingService({ ...base, importedSpec: base }));
    await h.repo.reconcileFromCompose("proj_1", [
      {
        name: "api",
        environment: { TOKEN: "", LOG_LEVEL: "debug" },
      },
    ]);
    expect(h.stored().environment).toEqual({ TOKEN: "saved-token", LOG_LEVEL: "debug" });
  });

  it("keeps image and command overrides with their provenance while updating other fields", async () => {
    const base = toComposeSpec({
      image: "example/api:1",
      commandArgv: ["run", "old"],
      ports: ["3000"],
      advanced: { imageTemplate: { expression: "example/api:${TAG}", unresolvedVariables: [] } },
    });
    const h = harness(
      existingService({
        ...base,
        importedSpec: base,
        image: "private/api:pinned",
        commandArgv: ["run", "custom"],
        advanced: {},
      }),
    );
    await h.repo.reconcileFromCompose("proj_1", [
      {
        name: "api",
        image: "example/api:2",
        ports: ["4000"],
        command: "run new",
        advanced: {
          imageTemplate: { expression: "example/api:${NEW_TAG}", unresolvedVariables: [] },
        },
      },
    ]);
    expect(h.stored()).toMatchObject({
      image: "private/api:pinned",
      command: null,
      commandArgv: ["run", "custom"],
      ports: ["4000"],
    });
    expect(h.stored().advanced).not.toHaveProperty("imageTemplate");
  });
});
