import { describe, expect, test } from "vitest";
import {
  ENV_MASK,
  hasMaskedValue,
  isMaskedValue,
  maskDeploymentEnv,
  maskDriftChanges,
  maskEnv,
  maskEnvironmentMeta,
  maskScanService,
  maskServiceEnv,
  maskServicesEnv,
  unmaskEnv,
} from "../../src/lib/secret-env";

describe("maskEnv", () => {
  test("blanks every value regardless of key", () => {
    expect(maskEnv({ NODE_ENV: "production", API_TOKEN: "xyz", PORT: "3000" })).toEqual({
      NODE_ENV: ENV_MASK,
      API_TOKEN: ENV_MASK,
      PORT: ENV_MASK,
    });
  });
  test("leaves an EMPTY value empty — dots there would fake a set value (#472)", () => {
    // A `${VAR:?…}` with nothing to resolve from parses to "", and the wizard
    // reads that empty string as "this needs a value". Masking it showed a
    // filled-looking field for a variable that was unset.
    expect(maskEnv({ POSTGRES_PASSWORD: "", API_TOKEN: "xyz" })).toEqual({
      POSTGRES_PASSWORD: "",
      API_TOKEN: ENV_MASK,
    });
  });
  test("null/undefined/empty → {}", () => {
    expect(maskEnv(null)).toEqual({});
    expect(maskEnv(undefined)).toEqual({});
    expect(maskEnv({})).toEqual({});
  });
  test("returns a copy (does not mutate input)", () => {
    const input = { SECRET: "real" };
    maskEnv(input);
    expect(input.SECRET).toBe("real");
  });
});

describe("unmaskEnv", () => {
  const stored = { API_TOKEN: "real-token", DB_PASSWORD: "hunter2", NODE_ENV: "production" };

  test("sentinel value restores the stored secret", () => {
    const incoming = { API_TOKEN: ENV_MASK, DB_PASSWORD: ENV_MASK, NODE_ENV: ENV_MASK };
    expect(unmaskEnv(incoming, stored)).toEqual(stored);
  });
  test("real incoming value overwrites stored", () => {
    const incoming = { API_TOKEN: "new-token", DB_PASSWORD: ENV_MASK, NODE_ENV: "production" };
    expect(unmaskEnv(incoming, stored)).toEqual({
      API_TOKEN: "new-token",
      DB_PASSWORD: "hunter2",
      NODE_ENV: "production",
    });
  });
  test("sentinel with no stored counterpart is dropped (never persists dots)", () => {
    expect(unmaskEnv({ GHOST: ENV_MASK }, stored)).toEqual({});
  });
  test("keys removed by the client are removed (whole-map replace)", () => {
    const incoming = { API_TOKEN: ENV_MASK };
    expect(unmaskEnv(incoming, stored)).toEqual({ API_TOKEN: "real-token" });
  });
  test("no stored map → sentinels drop, real values kept", () => {
    expect(unmaskEnv({ A: ENV_MASK, B: "real" }, undefined)).toEqual({ B: "real" });
  });
});

describe("helpers", () => {
  test("isMaskedValue / hasMaskedValue", () => {
    expect(isMaskedValue(ENV_MASK)).toBe(true);
    expect(isMaskedValue("real")).toBe(false);
    expect(hasMaskedValue({ A: "real", B: ENV_MASK })).toBe(true);
    expect(hasMaskedValue({ A: "real" })).toBe(false);
    expect(hasMaskedValue(null)).toBe(false);
  });

  test("maskServiceEnv masks environment, leaves other fields, does not mutate", () => {
    const svc = { name: "db", image: "postgres", environment: { PASSWORD: "secret" } };
    const masked = maskServiceEnv(svc);
    expect(masked.environment).toEqual({ PASSWORD: ENV_MASK });
    expect(masked.image).toBe("postgres");
    expect(svc.environment.PASSWORD).toBe("secret");
  });

  test("maskServiceEnv passes through service with no environment", () => {
    const svc = { name: "web" } as { name: string; environment?: Record<string, string> };
    expect(maskServiceEnv(svc)).toBe(svc);
  });

  test("maskServicesEnv over a list, null-tolerant", () => {
    expect(maskServicesEnv([{ environment: { A: "1" } }])).toEqual([{ environment: { A: ENV_MASK } }]);
    expect(maskServicesEnv(null)).toEqual([]);
  });

  test("maskDriftChanges masks only the environment field", () => {
    const changes = [
      { field: "image", from: "a", to: "b" },
      { field: "environment", from: { K: "old" }, to: { K: "new" } },
    ];
    expect(maskDriftChanges(changes)).toEqual([
      { field: "image", from: "a", to: "b" },
      { field: "environment", from: { K: ENV_MASK }, to: { K: ENV_MASK } },
    ]);
  });
});

describe("maskEnvironmentMeta", () => {
  test("keeps source/variable, masks value-bearing fields, drops expression", () => {
    const meta = {
      DB_PASSWORD: { source: "env-file", variable: "DB_PASSWORD", resolvedValue: "hunter2", defaultValue: "changeme", expression: "${DB_PASSWORD:-changeme}" },
      NODE_ENV: { source: "default", resolvedValue: "production" },
    };
    expect(maskEnvironmentMeta(meta)).toEqual({
      DB_PASSWORD: { source: "env-file", variable: "DB_PASSWORD", resolvedValue: ENV_MASK, defaultValue: ENV_MASK },
      NODE_ENV: { source: "default", resolvedValue: ENV_MASK },
    });
  });

  test("keeps `required` and the empty resolvedValue of a mandatory variable (#472)", () => {
    // Both are what the wizard renders "Needs value" from; masking either hid the
    // one row the user has to fill in.
    expect(
      maskEnvironmentMeta({
        POSTGRES_PASSWORD: {
          source: "missing",
          variable: "POSTGRES_PASSWORD",
          required: true,
          resolvedValue: "",
        },
      }),
    ).toEqual({
      POSTGRES_PASSWORD: {
        source: "missing",
        variable: "POSTGRES_PASSWORD",
        required: true,
        resolvedValue: "",
      },
    });
  });
});

describe("maskScanService", () => {
  test("masks both environment and environmentMeta values", () => {
    const svc = {
      name: "db",
      environment: { PASSWORD: "secret" },
      environmentMeta: { PASSWORD: { source: "env-file", resolvedValue: "secret" } },
    };
    const masked = maskScanService(svc);
    expect(masked.environment).toEqual({ PASSWORD: ENV_MASK });
    expect(masked.environmentMeta).toEqual({ PASSWORD: { source: "env-file", resolvedValue: ENV_MASK } });
    // input untouched
    expect(svc.environment.PASSWORD).toBe("secret");
  });
});

describe("maskDeploymentEnv", () => {
  test("masks meta.composeServices[].environment, leaves other meta fields", () => {
    const dep = {
      id: "dep_1",
      status: "ready",
      meta: {
        previousActiveDeploymentId: "dep_0",
        composeServices: [
          { name: "web", environment: { API_TOKEN: "xyz" } },
          { name: "db", environment: { PASSWORD: "p" } },
        ],
      },
    };
    const masked = maskDeploymentEnv(dep);
    expect(masked.meta.composeServices[0].environment).toEqual({ API_TOKEN: ENV_MASK });
    expect(masked.meta.composeServices[1].environment).toEqual({ PASSWORD: ENV_MASK });
    expect(masked.meta.previousActiveDeploymentId).toBe("dep_0");
    // stored object untouched (rollback reads real values)
    expect(dep.meta.composeServices[0].environment.API_TOKEN).toBe("xyz");
  });
  test("no-op without meta.composeServices", () => {
    expect(maskDeploymentEnv({ id: "d", meta: { foo: 1 } })).toEqual({ id: "d", meta: { foo: 1 } });
    expect(maskDeploymentEnv(null)).toBeNull();
    expect(maskDeploymentEnv(undefined)).toBeUndefined();
  });
});
