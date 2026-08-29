import { describe, expect, it, vi } from "vitest";

// Skip the full zod-validated env (which refuses to load outside desktop mode
// without INTERNAL_TOKEN); the crypto helpers only need BETTER_AUTH_SECRET.
vi.mock("../../src/config/env", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-for-data-transfer-unit-tests", CLOUD_MODE: false },
}));

import { encrypt, decrypt } from "../../src/lib/encryption";
import { encryptSecretField, decryptSecretField } from "../../src/lib/credential-encryption";
import {
  sealSecretBundle,
  openSecretBundle,
  openTransferSecrets,
  WrongPassphraseError,
} from "../../src/modules/system/data-transfer/passphrase-crypto";
import { extractPlaintext, sealForInstance } from "../../src/modules/system/data-transfer/secret-codec";
import { SECRET_COLUMNS, type SecretColumn } from "../../src/modules/system/data-transfer/secret-registry";
import {
  EXPORT_HISTORY_CATEGORIES,
  HISTORY_TABLES,
  InvalidExportSelectionError,
  resolveExportSelection,
  summarizeExportCounts,
} from "../../src/modules/system/data-transfer/selection";
import type { SecretBundle } from "../../src/modules/system/data-transfer/types";
import {
  clearDirectReceiveSessionsForTest,
  createDirectReceiveSession,
  decodeDirectTransferCode,
  DirectTransferSessionError,
  receiveDirectTransfer,
  sealDirectTransferPayload,
  sendDirectTransfer,
} from "../../src/modules/system/data-transfer/direct-transfer.service";
import { importPreparedInstance, InvalidTransferFileError } from "../../src/modules/system/data-transfer/import.service";
import type { DataTransferFile, DirectTransferPayload } from "../../src/modules/system/data-transfer/types";

// The codec only reads scheme/secretPaths/sqlName/column, so a minimal cast is
// enough to exercise it without touching the DB-backed registry.
function spec(scheme: SecretColumn["scheme"], column: string, secretPaths?: string[]): SecretColumn {
  return { sqlName: "t", table: {} as never, pk: {} as never, column, scheme, secretPaths } as SecretColumn;
}

describe("passphrase-crypto", () => {
  const bundle: SecretBundle = {
    version: 1,
    entries: [{ table: "env_var", id: "env_1", column: "value", scheme: "scalar", value: "top-secret" }],
  };

  it("round-trips with the correct passphrase", () => {
    const sealed = sealSecretBundle(bundle, "correct horse");
    expect(openSecretBundle(sealed, "correct horse")).toEqual(bundle);
  });

  it("does not leak plaintext into the sealed output", () => {
    const sealed = sealSecretBundle(bundle, "correct horse");
    expect(JSON.stringify(sealed)).not.toContain("top-secret");
  });

  it("rejects a wrong passphrase", () => {
    const sealed = sealSecretBundle(bundle, "correct horse");
    expect(() => openSecretBundle(sealed, "wrong")).toThrow(WrongPassphraseError);
  });

  it("requires a transfer secret whenever the export contains credentials", () => {
    const sealed = sealSecretBundle(bundle, "correct horse");
    expect(() => openTransferSecrets(sealed)).toThrow(WrongPassphraseError);
    expect(openTransferSecrets(null)).toBeNull();
  });
});

describe("one-time direct instance transfer", () => {
  it("creates a decodable, expiring destination capability", () => {
    clearDirectReceiveSessionsForTest();
    const created = createDirectReceiveSession({ apiBase: "https://new.example/api/", mode: "wipe" });
    const decoded = decodeDirectTransferCode(created.code);
    expect(decoded.apiBase).toBe("https://new.example/api/");
    expect(decoded.mode).toBe("wipe");
    expect(decoded.token.length).toBeGreaterThan(32);
    expect(Date.parse(decoded.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("authenticates and decrypts once, then consumes the receive code", async () => {
    clearDirectReceiveSessionsForTest();
    const created = createDirectReceiveSession({ apiBase: "https://new.example/api/", mode: "wipe" });
    const connection = decodeDirectTransferCode(created.code);
    const payload: DirectTransferPayload = {
      version: 1,
      authorizationToken: connection.token,
      // Deliberately invalid after decryption: proves the encrypted capability
      // opened, while stopping before any restore query/write.
      file: { kind: "bad" } as unknown as DataTransferFile,
      secrets: null,
    };
    const envelope = sealDirectTransferPayload(connection, payload);

    await expect(receiveDirectTransfer(envelope)).rejects.toThrow(InvalidTransferFileError);
    await expect(receiveDirectTransfer(envelope)).rejects.toThrow(DirectTransferSessionError);
  });

  it("rejects a payload that does not know the capability token", async () => {
    clearDirectReceiveSessionsForTest();
    const created = createDirectReceiveSession({ apiBase: "https://new.example/api/", mode: "merge" });
    const connection = decodeDirectTransferCode(created.code);
    const envelope = sealDirectTransferPayload(connection, {
      version: 1,
      authorizationToken: "not-the-token",
      file: { kind: "bad" } as unknown as DataTransferFile,
      secrets: null,
    });
    await expect(receiveDirectTransfer(envelope)).rejects.toThrow(DirectTransferSessionError);
  });

  it("refuses a receive code generated by the same instance before building a dump", async () => {
    clearDirectReceiveSessionsForTest();
    const created = createDirectReceiveSession({ apiBase: "https://same.example/api/", mode: "wipe" });
    await expect(sendDirectTransfer({ code: created.code })).rejects.toThrow("same instance");
  });

  it("validates a decrypted credential bundle before the first restore operation", async () => {
    const file = {
      kind: "openship-instance-export",
      envelopeVersion: 1,
      dump: { scope: { kind: "instance" }, tables: {} },
    } as unknown as DataTransferFile;
    await expect(importPreparedInstance({
      file,
      secrets: { version: 1, entries: [{ table: "env_var", id: "1", column: "value", scheme: "scalar", value: 42 }] } as never,
      mode: "wipe",
    })).rejects.toThrow(InvalidTransferFileError);
  });
});

describe("secret-codec round-trips (extract → seal → decrypt)", () => {
  it("scalar", () => {
    const stored = encrypt("db-url");
    const entry = extractPlaintext(spec("scalar", "value"), "id1", stored);
    expect(entry?.value).toBe("db-url");
    const sealedCell = sealForInstance(spec("scalar", "value"), entry!) as string;
    expect(decrypt(sealedCell)).toBe("db-url");
  });

  it("enc1 (ssh credential envelope)", () => {
    const stored = encryptSecretField("hunter2");
    const entry = extractPlaintext(spec("enc1", "sshPassword"), "id1", stored);
    expect(entry?.value).toBe("hunter2");
    const sealedCell = sealForInstance(spec("enc1", "sshPassword"), entry!) as string;
    expect(decryptSecretField(sealedCell)).toBe("hunter2");
  });

  it("plaintext (tunnelToken)", () => {
    const entry = extractPlaintext(spec("plaintext", "tunnelToken"), "id1", "raw-token");
    expect(entry?.value).toBe("raw-token");
    expect(sealForInstance(spec("plaintext", "tunnelToken"), entry!)).toBe("raw-token");
  });

  it("map (deployment.envVars)", () => {
    const stored = { A: encrypt("1"), B: encrypt("2") };
    const entry = extractPlaintext(spec("map", "envVars"), "id1", stored);
    expect(entry?.map).toEqual({ A: "1", B: "2" });
    const sealedCell = sealForInstance(spec("map", "envVars"), entry!) as Record<string, string>;
    expect(decrypt(sealedCell.A)).toBe("1");
    expect(decrypt(sealedCell.B)).toBe("2");
  });

  it("notification-config: secret sub-fields travel, plaintext fields preserved", () => {
    const s = spec("notification-config", "config", ["hmacSecret", "webhookUrl"]);
    const stored = { url: "https://hook", channelName: "ops", hmacSecret: encrypt("sig") };
    const entry = extractPlaintext(s, "id1", stored);
    expect(entry?.config).toEqual({ hmacSecret: "sig" });

    // Re-hydration merges the secret back into the restored (scrubbed) config.
    const restored = { url: "https://hook", channelName: "ops" };
    const sealedCell = sealForInstance(s, entry!, restored) as Record<string, unknown>;
    expect(sealedCell.url).toBe("https://hook");
    expect(sealedCell.channelName).toBe("ops");
    expect(decrypt(sealedCell.hmacSecret as string)).toBe("sig");
  });

  it("returns null for empty/absent cells", () => {
    expect(extractPlaintext(spec("scalar", "value"), "id1", null)).toBeNull();
    expect(extractPlaintext(spec("scalar", "value"), "id1", "")).toBeNull();
  });
});

describe("server credential transfer coverage (#656)", () => {
  it("registers every SSH credential column for decrypt and destination re-encryption", () => {
    const columns = SECRET_COLUMNS
      .filter((entry) => entry.sqlName === "servers")
      .map((entry) => [entry.column, entry.scheme]);

    expect(columns).toEqual([
      ["sshPassword", "enc1"],
      ["sshPrivateKey", "enc1"],
      ["sshKeyPassphrase", "enc1"],
    ]);
  });
});

describe("dependency-safe export filtering (#656)", () => {
  it("summarizes core and each optional history group for the pre-export UI", () => {
    expect(summarizeExportCounts({
      project: 3,
      servers: 2,
      resource_usage: 100,
      server_analytics: 20,
      audit_event: 7,
      notification_delivery: 4,
      backup_run: 5,
      backup_restore: 2,
      service_incident: 6,
      docker_migration_run: 1,
    })).toEqual({
      core: 5,
      history: { analytics: 120, activity: 11, backups: 7, incidents: 6, migrations: 1 },
      total: 150,
    });
  });

  it("keeps the legacy full export when selection is omitted", () => {
    expect(resolveExportSelection()).toEqual({
      selection: { history: [...EXPORT_HISTORY_CATEGORIES] },
      excludedTables: [],
    });
  });

  it("excludes only unselected optional history groups", () => {
    const result = resolveExportSelection({ history: ["incidents"] });
    expect(result.selection.history).toEqual(["incidents"]);
    expect(result.excludedTables).toEqual([
      ...HISTORY_TABLES.analytics,
      ...HISTORY_TABLES.activity,
      ...HISTORY_TABLES.backups,
      ...HISTORY_TABLES.migrations,
    ]);
    expect(result.excludedTables).not.toContain("service_incident");
    expect(result.excludedTables).not.toContain("servers");
    expect(result.excludedTables).not.toContain("project");
  });

  it("rejects arbitrary table/category input", () => {
    expect(() =>
      resolveExportSelection({ history: ["servers" as never] }),
    ).toThrow(InvalidExportSelectionError);
  });
});
