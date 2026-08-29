import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "@repo/core";

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

import { decrypt, encrypt } from "../../../src/lib/encryption";
import { revealServiceEnvVars, setServiceEnvVars, updateService } from "../../../src/modules/services/service.service";

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
