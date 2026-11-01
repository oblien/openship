import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "@repo/core";
import { toComposeSpec } from "@repo/db";
import { mergeServiceDeployEnv } from "@repo/platform/engine/modules/deployments/compose/service-env-layers";

const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(), listEnvVars: vi.fn(), bulkSetEnvVars: vi.fn(),
}));
const serviceRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  listByProject: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: { ...actual.repos, project: projectRepo, service: serviceRepo },
  };
});

import { decrypt, encrypt } from "@repo/platform/engine/lib/encryption";
import { acceptServiceDrift, keepServiceDrift, listServices, revealServiceEnvVars, setServiceEnvVars, updateService } from "@repo/platform/engine/modules/services/service.service";

const ctx = { organizationId: "org_1" } as never;
const project = { id: "proj_1", organizationId: "org_1", internalAlias: null };

const initialEnv = {
  GEMINI_API_KEY: "secret-gemini-key-12345",
  TEST_AUTH: "true",
  DATABASE_URL: "postgres://user:pass@db:5432/inventar",
  MARKET_ENDPOINT: "https://market.inventar.example.com",
  BUILD_REVISION: "v1.2.0",
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "svc_inventar",
  projectId: project.id,
  name: "inventar",
  kind: "compose",
  image: "inventar:latest",
  environment: { ...initialEnv },
  ports: [],
  restart: "unless-stopped",
  enabled: true,
  exposed: false,
  ...over,
});

const written = () => serviceRepo.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  projectRepo.findById.mockReset().mockResolvedValue(project);
  projectRepo.listEnvVars.mockReset().mockResolvedValue([]);
  projectRepo.bulkSetEnvVars.mockReset().mockResolvedValue(undefined);
  serviceRepo.findById.mockReset().mockResolvedValue(row());
  serviceRepo.update.mockReset().mockResolvedValue(undefined);
  serviceRepo.listByProject.mockReset().mockResolvedValue([]);
});

describe("service-scoped env_var editor", () => {
  it("round-trips an unchanged masked secret without encrypting the mask", async () => {
    const ciphertext = encrypt("real-secret");
    projectRepo.listEnvVars.mockResolvedValue([
      { id: "env_1", key: "API_TOKEN", value: ciphertext, isSecret: true },
    ]);
    await setServiceEnvVars(ctx, project.id, "svc_inventar", {
      environment: "production",
      vars: [{ key: "API_TOKEN", value: ENV_MASK, isSecret: true }],
    });
    expect(projectRepo.bulkSetEnvVars).toHaveBeenCalledWith(
      project.id, "production",
      [{ key: "API_TOKEN", value: ciphertext, isSecret: true }],
      "svc_inventar",
    );
  });

  it("renames an unrevealed secret by stable row identity without losing its value", async () => {
    const ciphertext = encrypt("real-secret");
    projectRepo.listEnvVars.mockResolvedValue([
      { id: "env_1", key: "OLD_API_TOKEN", value: ciphertext, isSecret: true },
    ]);

    await setServiceEnvVars(ctx, project.id, "svc_inventar", {
      environment: "production",
      vars: [{ sourceId: "env_1", key: "NEW_API_TOKEN", value: ENV_MASK, isSecret: true }],
    });

    expect(projectRepo.bulkSetEnvVars).toHaveBeenCalledWith(
      project.id, "production",
      [{ key: "NEW_API_TOKEN", value: ciphertext, isSecret: true }],
      "svc_inventar",
    );
  });

  it("rejects an unknown or reused source identity before replacing the scope", async () => {
    const ciphertext = encrypt("real-secret");
    projectRepo.listEnvVars.mockResolvedValue([
      { id: "env_1", key: "API_TOKEN", value: ciphertext, isSecret: true },
    ]);

    await expect(setServiceEnvVars(ctx, project.id, "svc_inventar", {
      environment: "production",
      vars: [{ sourceId: "missing", key: "RENAMED", value: ENV_MASK, isSecret: true }],
    })).rejects.toThrow("invalid-env-source:missing");
    expect(projectRepo.bulkSetEnvVars).not.toHaveBeenCalled();

    await expect(setServiceEnvVars(ctx, project.id, "svc_inventar", {
      environment: "production",
      vars: [
        { sourceId: "env_1", key: "RENAMED_ONE", value: ENV_MASK, isSecret: true },
        { sourceId: "env_1", key: "RENAMED_TWO", value: ENV_MASK, isSecret: true },
      ],
    })).rejects.toThrow("duplicate-env-source:env_1");
    expect(projectRepo.bulkSetEnvVars).not.toHaveBeenCalled();
  });

  it("stores a new manual variable in env_var and protects secret-looking keys", async () => {
    await setServiceEnvVars(ctx, project.id, "svc_inventar", {
      environment: "production", vars: [{ key: "MANUAL_API_KEY", value: "keep-me" }],
    });
    const vars = projectRepo.bulkSetEnvVars.mock.calls.at(-1)?.[2];
    expect(vars[0]).toMatchObject({ key: "MANUAL_API_KEY", isSecret: true });
    expect(decrypt(vars[0].value)).toBe("keep-me");
  });

  it("rejects a mask with no stored source", async () => {
    await expect(setServiceEnvVars(ctx, project.id, "svc_inventar", {
      environment: "production", vars: [{ key: "GHOST", value: ENV_MASK, isSecret: true }],
    })).rejects.toThrow("masked-env-without-source:GHOST");
    expect(projectRepo.bulkSetEnvVars).not.toHaveBeenCalled();
  });

  it("rejects duplicate keys before replacing the scope", async () => {
    await expect(setServiceEnvVars(ctx, project.id, "svc_inventar", {
      environment: "production",
      vars: [{ key: "DUPLICATE", value: "one" }, { key: "DUPLICATE", value: "two" }],
    })).rejects.toThrow("duplicate-env-key:DUPLICATE");
    expect(projectRepo.bulkSetEnvVars).not.toHaveBeenCalled();
  });

  it("reveals service-scoped env_var values", async () => {
    projectRepo.listEnvVars.mockResolvedValue([
      { key: "MANUAL_ONLY", value: encrypt("service-value"), isSecret: true },
    ]);
    await expect(revealServiceEnvVars(
      ctx, project.id, "svc_inventar", "production",
    )).resolves.toEqual({ MANUAL_ONLY: "service-value" });
  });
});

describe("updateService — environment partial updates merge rather than replace", () => {
  it("preserves untouched environment variables when applying a single-field probe or partial update", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      environment: {
        PROBE_FIELD: "test",
      },
    } as never);

    expect(written().environment).toEqual({
      ...initialEnv,
      PROBE_FIELD: "test",
    });
  });

  it("updates existing variable while preserving all other variables", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      environment: {
        BUILD_REVISION: "v1.2.1",
      },
    } as never);

    expect(written().environment).toEqual({
      ...initialEnv,
      BUILD_REVISION: "v1.2.1",
    });
  });

  it("deletes a variable when explicitly set to null while preserving other variables", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      environment: {
        BUILD_REVISION: null,
      },
    } as never);

    expect(written().environment).toEqual({
      GEMINI_API_KEY: "secret-gemini-key-12345",
      TEST_AUTH: "true",
      DATABASE_URL: "postgres://user:pass@db:5432/inventar",
      MARKET_ENDPOINT: "https://market.inventar.example.com",
    });
  });

  it("restores masked secret sentinels to their stored values", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      environment: {
        GEMINI_API_KEY: ENV_MASK,
        NEW_KEY: "new_value",
      },
    } as never);

    expect(written().environment).toEqual({
      ...initialEnv,
      NEW_KEY: "new_value",
    });
  });

  it("clears the entire environment map when explicitly passed null", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      environment: null,
    } as never);

    expect(written().environment).toEqual({});
  });

  it("leaves environment unchanged when environment is not mentioned in patch", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      restart: "always",
    } as never);

    expect(written()).not.toHaveProperty("environment");
  });
});


describe("inline environment ownership and Compose recovery (#893)", () => {
  const source = toComposeSpec({
    image: "inventar:latest", environmentTemplates: { MY_VAR: "${MY_VAR}" },
  });
  const stateful = (overrides: Record<string, unknown> = {}) => {
    let stored = row({
      environment: { MY_VAR: "cached-secret" },
      advanced: { environmentTemplateKeys: ["MY_VAR"] },
      importedSpec: source, driftSpec: source, ...overrides,
    });
    serviceRepo.findById.mockImplementation(async () => stored);
    serviceRepo.listByProject.mockImplementation(async () => [stored]);
    serviceRepo.update.mockImplementation(async (_id, patch) => { stored = { ...stored, ...patch }; });
    return () => stored;
  };

  it("makes a direct inline edit literal without claiming untouched cached keys", async () => {
    stateful({ environment: { MY_VAR: "cached-secret", OTHER: "old" } });
    await updateService(ctx, project.id, "svc_inventar", { environment: { OTHER: "$HOME" } } as never);
    expect(written().advanced).toMatchObject({
      environmentOverrideKeys: ["OTHER"], environmentTemplateKeys: ["MY_VAR"],
    });
    expect(written().environment).toEqual({ MY_VAR: "cached-secret", OTHER: "$HOME" });
  });

  it("does not change template semantics for a masked or unchanged value", async () => {
    stateful({ environment: { MY_VAR: "${MY_VAR}" } });
    for (const value of [ENV_MASK, "${MY_VAR}"]) {
      await updateService(ctx, project.id, "svc_inventar", { environment: { MY_VAR: value } } as never);
      expect(written()).not.toHaveProperty("advanced");
    }
  });

  it("records explicit removals without restoring the removed template later", async () => {
    stateful();
    await updateService(ctx, project.id, "svc_inventar", { environment: { MY_VAR: null } } as never);
    expect(written().environment).toEqual({});
    expect(written().advanced).toMatchObject({
      environmentOverrideKeys: ["MY_VAR"], environmentTemplateKeys: [],
    });
  });

  it("shows a masked live diff when a broken baseline already equals the source", async () => {
    stateful();
    const result = await listServices(ctx, project.id);
    expect(result[0].drift?.changes.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("cached-secret");
    expect(result[0]).not.toHaveProperty("importedSpec");
    expect(result[0]).not.toHaveProperty("driftSpec");
  });

  it("accepts the source once and uses every subsequent project value with existing precedence", async () => {
    const stored = stateful({ environment: { MY_VAR: "${MY_VAR}" } });
    await acceptServiceDrift(ctx, project.id, "svc_inventar");
    for (const value of ["B", "C"]) {
      const layers = {
        project: { MY_VAR: value }, frozen: {}, service: {},
        inline: stored().environment,
        templateKeys: (stored() as any).advanced.environmentTemplateKeys,
      };
      expect(mergeServiceDeployEnv(layers, false).env.MY_VAR).toBe(value);
      expect(mergeServiceDeployEnv({ ...layers, service: { MY_VAR: "service-override" } }, false).env.MY_VAR)
        .toBe("service-override");
      expect(mergeServiceDeployEnv({ ...layers, frozen: { MY_VAR: "release-value" } }, true).env.MY_VAR)
        .toBe("release-value");
    }
    expect((stored() as any).driftSpec).toBeNull();
  });

  it("accepts repo changes without erasing the only saved credential or other environment keys", async () => {
    const stored = stateful({
      environment: { MY_VAR: "saved-credential", EXTRA: "saved-extra" },
      driftSpec: toComposeSpec({
        image: "inventar:next",
        environmentTemplates: { MY_VAR: "${MY_VAR:?required}" },
      }),
    });
    await acceptServiceDrift(ctx, project.id, "svc_inventar");
    expect(stored()).toMatchObject({
      image: "inventar:next",
      environment: { MY_VAR: "saved-credential", EXTRA: "saved-extra" },
      driftSpec: null,
    });
    const layers = {
      project: {},
      frozen: {},
      service: {},
      inline: stored().environment,
      templateKeys: (stored() as any).advanced.environmentTemplateKeys,
    };
    const merged = mergeServiceDeployEnv(layers, false);
    expect(merged.env).toMatchObject({ MY_VAR: "saved-credential", EXTRA: "saved-extra" });
    expect(merged.missingRequired).toEqual([]);
    expect(projectRepo.bulkSetEnvVars).not.toHaveBeenCalled();
    expect(
      mergeServiceDeployEnv({ ...layers, service: { MY_VAR: "scoped-override" } }, false).env
        .MY_VAR,
    ).toBe("scoped-override");
  });

  it("keeps a reviewed cached value as an explicit literal override", async () => {
    const stored = stateful();
    await keepServiceDrift(ctx, project.id, "svc_inventar");
    expect(stored().environment).toEqual({ MY_VAR: "cached-secret" });
    expect(written().advanced).toMatchObject({
      environmentOverrideKeys: ["MY_VAR"], environmentTemplateKeys: [],
    });
  });

  it("keeps a known older expression dynamic when declining a source edit", async () => {
    stateful({
      environment: { MY_VAR: "${OLD_VAR}" },
      importedSpec: toComposeSpec({ environmentTemplates: { MY_VAR: "${OLD_VAR}" } }),
    });
    await keepServiceDrift(ctx, project.id, "svc_inventar");
    expect(written().advanced).toMatchObject({
      environmentOverrideKeys: ["MY_VAR"], environmentTemplateKeys: ["MY_VAR"],
    });
  });
});
