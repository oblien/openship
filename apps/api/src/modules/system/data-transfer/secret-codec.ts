/**
 * Per-scheme translation between a stored cell and a plaintext SecretEntry.
 *
 *  - extractPlaintext: EXPORT side. Decrypt a cell with THIS instance's key
 *    (the export runs on the source, which can decrypt its own data).
 *  - sealForInstance:  IMPORT side. Re-encrypt a plaintext entry under THIS
 *    (destination) instance's key, producing the value to write.
 *
 * Uses only the existing crypto helpers, so the envelope stays identical to
 * how each column is normally sealed at rest.
 */

import { encrypt, decrypt, decryptEnvMap } from "@repo/platform/engine/lib/encryption";
import {
  encryptSecretField,
  decryptSecretField,
} from "@repo/platform/engine/lib/credential-encryption";
import { createConfigurationSecrets, SERVICE_SECRET_FIELDS } from "@repo/db/configuration-secrets";

import type { SecretColumn } from "./secret-registry";
import type { SecretEntry } from "./types";

const configuration = createConfigurationSecrets({ encrypt, decrypt });
function configurationCell(spec: SecretColumn, cell: unknown, direction: "open" | "seal"): unknown {
  if (spec.sqlName === "deployment" && spec.column === "meta") {
    return direction === "open"
      ? configuration.openDeploymentMeta(cell)
      : configuration.sealDeploymentMeta(cell);
  }
  if (spec.sqlName === "service" && SERVICE_SECRET_FIELDS.some((key) => key === spec.column)) {
    return direction === "open" ? configuration.openJson(cell) : configuration.sealJson(cell);
  }
  return structuredClone(cell);
}

/** Decrypt one stored cell → plaintext entry, or null if empty/absent. */
export function extractPlaintext(
  spec: SecretColumn,
  id: string,
  cell: unknown,
): SecretEntry | null {
  if (cell === null || cell === undefined) return null;
  const base = { table: spec.sqlName, id, column: spec.column } as const;

  switch (spec.scheme) {
    case "json":
      return { ...base, scheme: "json", json: configurationCell(spec, cell, "open") };
    case "scalar": {
      if (typeof cell !== "string" || cell === "") return null;
      return { ...base, scheme: "scalar", value: decrypt(cell) };
    }
    case "enc1": {
      if (typeof cell !== "string" || cell === "") return null;
      const value = decryptSecretField(cell);
      return value === undefined ? null : { ...base, scheme: "enc1", value };
    }
    case "plaintext": {
      if (typeof cell !== "string" || cell === "") return null;
      return { ...base, scheme: "plaintext", value: cell };
    }
    case "map": {
      if (typeof cell !== "object") return null;
      const map = decryptEnvMap(cell as Record<string, string>);
      return Object.keys(map).length === 0 ? null : { ...base, scheme: "map", map };
    }
    case "notification-config": {
      if (typeof cell !== "object") return null;
      const obj = cell as Record<string, unknown>;
      const config: Record<string, string> = {};
      for (const path of spec.secretPaths ?? []) {
        const v = obj[path];
        if (typeof v === "string" && v !== "") config[path] = decrypt(v);
      }
      return Object.keys(config).length === 0
        ? null
        : { ...base, scheme: "notification-config", config };
    }
  }
}

/**
 * Re-encrypt a plaintext entry under the destination instance's key → the cell
 * value to write. For notification-config, `currentCell` is the restored
 * (secret-scrubbed) config object the secret sub-fields are merged back into.
 */
export function sealForInstance(
  spec: SecretColumn,
  entry: SecretEntry,
  currentCell?: unknown,
): unknown {
  switch (spec.scheme) {
    case "json":
      return configurationCell(spec, entry.json, "seal");
    case "scalar":
      return entry.value != null ? encrypt(entry.value) : null;
    case "enc1":
      return entry.value != null ? encryptSecretField(entry.value) : null;
    case "plaintext":
      return entry.value ?? null;
    case "map": {
      if (!entry.map) return null;
      const sealed: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry.map)) sealed[k] = encrypt(v);
      return sealed;
    }
    case "notification-config": {
      const merged =
        currentCell && typeof currentCell === "object"
          ? { ...(currentCell as Record<string, unknown>) }
          : {};
      for (const [k, v] of Object.entries(entry.config ?? {})) merged[k] = encrypt(v);
      return merged;
    }
  }
}
