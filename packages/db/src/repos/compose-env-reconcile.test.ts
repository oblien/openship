import { createConfigurationSecrets } from "../configuration-secrets";
import { createEncryption } from "../encryption";
import { describe, expect, it } from "vitest";
import type { Database } from "../client";
import {
  createServiceRepo,
  removedComposeEnvironmentKeys,
  toComposeSpec,
  type ParsedComposeService,
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

function existingService(overrides: Record<string, unknown> = {}) {
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
function harness(initial = existingService()) {
  let stored = structuredClone(initial);
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    query: { service: { findMany: async () => [stored] } },
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: async () => {
          writes.push(configuration.openService(data));
          stored = { ...stored, ...data };
        },
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
  it("detects only removed keys, not additions or value rotations", () => {
    expect(
      removedComposeEnvironmentKeys(
        toComposeSpec({ environment: fullEnvironment }),
        toComposeSpec({
          environment: {
            ...fullEnvironment,
            BETTER_AUTH_SECRET: "rotated",
            NEW_KEY: "added",
          },
        }),
      ),
    ).toEqual([]);

    const { SMTP_HOST: _removed, ...withoutSmtp } = fullEnvironment;
    expect(
      removedComposeEnvironmentKeys(
        toComposeSpec({ environment: fullEnvironment }),
        toComposeSpec({ environment: withoutSmtp }),
      ),
    ).toEqual(["SMTP_HOST"]);
  });

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

    expect(result.driftedNames).toEqual(["api"]);
    expect(h.stored().environment).toEqual(fullEnvironment);
    expect(h.stored().importedSpec).toEqual(existingService().importedSpec);
    expect(h.stored().driftSpec).toEqual(toComposeSpec(proposed));
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
    expect(h.stored().driftSpec).toEqual(toComposeSpec(proposed));
  });

  it("does not smuggle unrelated image, port, or volume changes through with a deletion", async () => {
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
      image: "example/api:1",
      ports: ["4000"],
      volumes: ["api_data:/data"],
      environment: fullEnvironment,
      driftSpec: toComposeSpec(proposed),
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
    expect(h.stored().driftSpec).toEqual(toComposeSpec(proposed));
  });

  it("does not churn the row when the same destructive drift is already pending", async () => {
    const proposed: ParsedComposeService = {
      name: "api",
      image: "example/api:1",
      ports: ["4000"],
      environment: { NODE_ENV: "production" },
      volumes: ["api_data:/data"],
    };
    const h = harness(existingService({ driftSpec: toComposeSpec(proposed) }));

    const result = await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(result.driftedNames).toEqual(["api"]);
    expect(h.writes).toHaveLength(0);
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
  const row = (overrides: Record<string, unknown> = {}) => existingService({
    ports: [], volumes: [], environment: { MY_VAR: "A" }, importedSpec: null, ...overrides,
  });

  it("keeps an ambiguous cached value reviewable across repeated refreshes", async () => {
    const h = harness(row());
    for (const value of ["B", "C"]) {
      const result = await h.repo.reconcileFromCompose("proj_1", [source(value)]);
      expect(result.unresolvedEnvironment).toEqual([{ name: "api", keys: ["MY_VAR"] }]);
      expect(result.driftedNames).toEqual(["api"]);
      expect(h.stored().environment).toEqual({ MY_VAR: "A" });
      expect(h.stored().importedSpec).toBeNull();
      expect(h.stored().driftSpec).toEqual(toComposeSpec(source(value)));
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

  it("detects an already-poisoned baseline without rewriting the same pending drift", async () => {
    const h = harness(row({
      advanced: { environmentTemplateKeys: ["MY_VAR"] },
      importedSpec: toComposeSpec(source()),
    }));
    for (let i = 0; i < 2; i++) {
      expect((await h.repo.reconcileFromCompose("proj_1", [source()])).unresolvedEnvironment)
        .toEqual([{ name: "api", keys: ["MY_VAR"] }]);
      expect(h.stored().environment).toEqual({ MY_VAR: "A" });
    }
    expect(h.writes).toHaveLength(1);
  });

  it("still blocks ambiguous legacy values when the repo changes another field", async () => {
    const h = harness(row({
      advanced: { environmentTemplateKeys: ["MY_VAR"] },
      importedSpec: toComposeSpec(source()),
    }));
    const proposed = { ...source(), image: "example/api:2" };
    const result = await h.repo.reconcileFromCompose("proj_1", [proposed]);
    expect(result.unresolvedEnvironment).toEqual([{ name: "api", keys: ["MY_VAR"] }]);
    expect(h.stored().image).toBe("example/api:1");
    expect(h.stored().driftSpec).toEqual(toComposeSpec(proposed));
  });

  it("does not let one explicit edit claim another cached value", async () => {
    const h = harness(row({
      environment: { MY_VAR: "A", PINNED: "manual" },
      advanced: { environmentOverrideKeys: ["PINNED"] },
    }));
    const result = await h.repo.reconcileFromCompose("proj_1", [{
      ...source(), environment: { MY_VAR: "B", PINNED: "new" },
      environmentTemplates: { MY_VAR: "${MY_VAR}", PINNED: "${PINNED}" },
    }]);
    expect(result.unresolvedEnvironment).toEqual([{ name: "api", keys: ["MY_VAR"] }]);
    expect(h.stored().environment).toEqual({ MY_VAR: "A", PINNED: "manual" });
  });

  it("retains explicit deletions and known kept templates on later refreshes", async () => {
    for (const environment of [{}, { MY_VAR: "${OLD_VAR}" }]) {
      const h = harness(row({
        environment, importedSpec: toComposeSpec(source()),
        advanced: { environmentOverrideKeys: ["MY_VAR"], environmentTemplateKeys: ["MY_VAR"] },
      }));
      expect((await h.repo.reconcileFromCompose("proj_1", [source()])).unresolvedEnvironment).toEqual([]);
      expect(h.stored().environment).toEqual(environment);
      expect(h.stored().advanced?.environmentTemplateKeys).toEqual(["MY_VAR"]);
    }
  });
});
