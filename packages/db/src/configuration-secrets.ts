/**
 * Storage codec for JSON configuration containing inline secrets. Repositories
 * expose ordinary domain objects; only the persisted JSONB cell is a string.
 * Legacy objects remain readable until the bounded startup backfill seals them.
 * No environment access, connection, or process-global key lives in this module.
 */
import type { Encryption } from "./encryption";

export type ConfigurationEncryption = Pick<Encryption, "encrypt" | "decrypt">;
export const CONFIGURATION_PREFIX = "openship:config:v1:";
export const SERVICE_SECRET_FIELDS = [
  "environment",
  "buildArgs",
  "advanced",
  "importedSpec",
  "driftSpec",
] as const;
// Keep routing identity and composeDeployment.decision queryable in SQL. The
// service snapshot includes env, build args, advanced inline files and baselines.
export const DEPLOYMENT_SECRET_FIELDS = ["composeServices"] as const;

export function isPlainConfiguration(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

export function createConfigurationSecrets(encryption: ConfigurationEncryption) {
  function sealJson(value: unknown): unknown {
    if (value === undefined || value === null) return value;
    if (typeof value !== "object") throw new Error("Expected JSON configuration before encryption");
    if (!isPlainConfiguration(value)) return value;
    return CONFIGURATION_PREFIX + encryption.encrypt(JSON.stringify(value));
  }

  function openJson(value: unknown): unknown {
    if (value === undefined || value === null || typeof value === "object") return value;
    try {
      if (typeof value !== "string" || !value.startsWith(CONFIGURATION_PREFIX)) throw new Error();
      const plain: unknown = JSON.parse(
        encryption.decrypt(value.slice(CONFIGURATION_PREFIX.length)),
      );
      if (plain === null || typeof plain !== "object") throw new Error();
      return plain;
    } catch {
      // Never pass ciphertext to a runtime, expose it in errors, or turn a wrong
      // key into an empty configuration that could overwrite the stored secret.
      throw new Error("Unable to decrypt stored configuration with this installation's key");
    }
  }

  // This is the storage/domain boundary: schema types describe the plaintext
  // object callers use, while JSONB also accepts the sealed string on disk.
  function fields<T extends object>(
    row: T,
    keys: readonly string[],
    map: (value: unknown) => unknown,
  ): T {
    const copy = { ...row } as Record<string, unknown>;
    for (const key of keys) if (copy[key] !== undefined) copy[key] = map(copy[key]);
    return copy as T;
  }
  function sealService<T extends object>(row: T): T {
    return fields(row, SERVICE_SECRET_FIELDS, sealJson);
  }
  function openService<T extends object | undefined>(row: T): T {
    return row === undefined ? row : (fields(row, SERVICE_SECRET_FIELDS, openJson) as T);
  }
  function meta(value: unknown, map: (value: unknown) => unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid deployment configuration");
    return fields(value, DEPLOYMENT_SECRET_FIELDS, map);
  }
  function sealDeployment<T extends object>(row: T): T {
    return fields(row, ["meta"], (value) => meta(value, sealJson));
  }
  function openDeployment<T extends object | undefined>(row: T): T {
    return row === undefined ? row : (fields(row, ["meta"], (value) => meta(value, openJson)) as T);
  }
  return {
    sealJson,
    openJson,
    sealService,
    openService,
    sealDeployment,
    openDeployment,
    sealDeploymentMeta: (value: unknown) => meta(value, sealJson),
    openDeploymentMeta: (value: unknown) => meta(value, openJson),
  };
}
