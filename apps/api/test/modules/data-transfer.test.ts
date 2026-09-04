import { describe, expect, it, vi } from "vitest";
import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from "node:crypto";
import { db, eq, schema } from "@repo/db";

// Skip the full zod-validated env (which refuses to load outside desktop mode
// without INTERNAL_TOKEN); the crypto helpers only need BETTER_AUTH_SECRET.
vi.mock("../../src/config/env", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-for-data-transfer-unit-tests", CLOUD_MODE: false },
}));

import { decrypt, encrypt, encryptBytesWithKey, encryptWithKey } from "../../src/lib/encryption";
import { encryptSecretField, decryptSecretField } from "../../src/lib/credential-encryption";
import {
  sealSecretBundle,
  openSecretBundle,
  openTransferSecrets,
  WrongPassphraseError,
} from "../../src/modules/system/data-transfer/passphrase-crypto";
import {
  extractPlaintext,
  sealForInstance,
} from "../../src/modules/system/data-transfer/secret-codec";
import {
  SECRET_COLUMNS,
  type SecretColumn,
} from "../../src/modules/system/data-transfer/secret-registry";
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
  encodeDirectTransferCode,
  finalizeDirectChunkUpload,
  initializeDirectChunkUpload,
  receiveDirectTransfer,
  receiveDirectChunk,
  sealDirectTransferPayload,
  sendDirectTransfer,
} from "../../src/modules/system/data-transfer/direct-transfer.service";
import {
  claimSession,
  getSession,
  listChunkMetadata,
  releaseSessionClaim,
  sha256Hex,
  TransferStoreError,
} from "../../src/modules/system/data-transfer/chunk-store";
import {
  createFileUpload,
  finalizeFileUpload,
  uploadFileChunk,
} from "../../src/modules/system/data-transfer/file-upload.service";
import {
  importPreparedInstance,
  InvalidTransferFileError,
} from "../../src/modules/system/data-transfer/import.service";
import type {
  DataTransferFile,
  DirectTransferConnection,
  DirectTransferPayload,
} from "../../src/modules/system/data-transfer/types";
// The codec only reads scheme/secretPaths/sqlName/column, so a minimal cast is
// enough to exercise it without touching the DB-backed registry.
function spec(
  scheme: SecretColumn["scheme"],
  column: string,
  secretPaths?: string[],
): SecretColumn {
  return {
    sqlName: "t",
    table: {} as never,
    pk: {} as never,
    column,
    scheme,
    secretPaths,
  } as SecretColumn;
}

const DIRECT_KEY_CONTEXT = Buffer.from("openship-direct-transfer-v1", "utf8");

function testSender(connection: DirectTransferConnection) {
  const recipientPublicKey = createPublicKey({
    key: Buffer.from(connection.recipientPublicKey, "base64"),
    format: "der",
    type: "spki",
  });
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey, publicKey: recipientPublicKey });
  return {
    key: Buffer.from(
      hkdfSync("sha256", shared, Buffer.from(connection.sessionId, "utf8"), DIRECT_KEY_CONTEXT, 32),
    ),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function testSignature(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

describe("passphrase-crypto", () => {
  const bundle: SecretBundle = {
    version: 1,
    entries: [
      { table: "env_var", id: "env_1", column: "value", scheme: "scalar", value: "top-secret" },
    ],
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
  it("creates a decodable, expiring destination capability", async () => {
    await clearDirectReceiveSessionsForTest();
    const created = await createDirectReceiveSession({
      apiBase: "https://new.example/api/",
      mode: "wipe",
    });
    const decoded = decodeDirectTransferCode(created.code);
    expect(decoded.apiBase).toBe("https://new.example/api/");
    expect(decoded.mode).toBe("wipe");
    expect(decoded.token.length).toBeGreaterThan(32);
    expect(Date.parse(decoded.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("lets the destination authoritatively validate a renewed lease", () => {
    const code = encodeDirectTransferCode({
      version: 1,
      apiBase: "https://new.example/api/",
      recipientRuntimeId: "remote-runtime-id-0000000000000000",
      sessionId: "session-id",
      token: "x".repeat(43),
      recipientPublicKey: "public-key",
      mode: "merge",
      // An in-progress destination session may have renewed beyond this initial
      // timestamp; decode must not prevent the request from reaching it.
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(decodeDirectTransferCode(code).sessionId).toBe("session-id");
  });

  it("authenticates and decrypts once, then consumes the receive code", async () => {
    await clearDirectReceiveSessionsForTest();
    const created = await createDirectReceiveSession({
      apiBase: "https://new.example/api/",
      mode: "wipe",
    });
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
    await clearDirectReceiveSessionsForTest();
    const created = await createDirectReceiveSession({
      apiBase: "https://new.example/api/",
      mode: "merge",
    });
    const connection = decodeDirectTransferCode(created.code);
    const envelope = sealDirectTransferPayload(connection, {
      version: 1,
      authorizationToken: "not-the-token",
      file: { kind: "bad" } as unknown as DataTransferFile,
      secrets: null,
    });
    await expect(receiveDirectTransfer(envelope)).rejects.toThrow(DirectTransferSessionError);
  });

  it("refuses a receive code owned by the same database even across API workers", async () => {
    await clearDirectReceiveSessionsForTest();
    const created = await createDirectReceiveSession({
      apiBase: "https://same.example/api/",
      mode: "wipe",
    });
    const connection = decodeDirectTransferCode(created.code);
    const differentWorkerCode = encodeDirectTransferCode({
      ...connection,
      recipientRuntimeId: "other-worker-runtime-000000000000",
    });
    await expect(sendDirectTransfer({ code: differentWorkerCode })).rejects.toThrow(
      "same instance",
    );
  });

  it("uses bounded chunks and safely retries an ambiguous finalization", async () => {
    await clearDirectReceiveSessionsForTest();
    const created = await createDirectReceiveSession({
      apiBase: "https://new.example/api/",
      mode: "merge",
    });
    const connection = decodeDirectTransferCode(created.code);
    const code = encodeDirectTransferCode({
      ...connection,
      recipientRuntimeId: "remote-runtime-id-0000000000000000",
    });
    // The HTTP destination is mocked below; remove the locally-created fixture
    // so the durable same-instance guard correctly treats it as remote.
    await clearDirectReceiveSessionsForTest();
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    let finalizeAttempts = 0;
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({ url, init });
      if (url.pathname.endsWith("/finalize/stream")) {
        finalizeAttempts += 1;
        if (finalizeAttempts === 1) throw new TypeError("socket closed after commit");
        return new Response(
          `: ok\n\nevent: complete\ndata: ${JSON.stringify({
            mode: "merge",
            rowsRestored: 0,
            secretsRehydrated: 0,
            secretsSkipped: true,
            localPathProjects: [],
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await sendDirectTransfer({ code, fetchImpl });

    expect(result.destination).toBe("https://new.example");
    expect(requests[0]?.url.pathname).toBe("/api/system/data-transfer/direct/chunk/init");
    expect(String(requests[0]?.init.body)).not.toContain(connection.token);
    const uploads = requests.filter(({ init }) => init.method === "PUT");
    expect(uploads.length).toBeGreaterThan(0);
    expect(
      uploads.every(({ init }) => Buffer.from(init.body as Uint8Array).byteLength <= 8_000_032),
    ).toBe(true);
    expect(requests.at(-1)?.url.pathname).toContain("/finalize");
    expect(finalizeAttempts).toBe(2);
    expect(requests.some(({ url }) => url.pathname.endsWith("/direct/receive"))).toBe(false);
  });

  it("persists the receive capability and keeps a premature chunk finalize resumable", async () => {
    await clearDirectReceiveSessionsForTest();
    const created = await createDirectReceiveSession({
      apiBase: "https://new.example/api/",
      mode: "merge",
    });
    const connection = decodeDirectTransferCode(created.code);
    const sender = testSender(connection);
    const proof = encryptWithKey(
      sender.key,
      JSON.stringify({
        version: 1,
        sessionId: connection.sessionId,
        mode: connection.mode,
        authorizationToken: connection.token,
      }),
    );

    await initializeDirectChunkUpload({
      version: 1,
      sessionId: connection.sessionId,
      mode: connection.mode,
      senderPublicKey: sender.publicKey,
      proof,
    });
    expect(await getSession(connection.sessionId)).toMatchObject({
      kind: "direct",
      status: "uploading",
      senderPublicKey: sender.publicKey,
    });

    const plaintext = Buffer.from(
      JSON.stringify({
        version: 1,
        authorizationToken: connection.token,
        file: { kind: "bad" },
        secrets: null,
      } as unknown as DirectTransferPayload),
      "utf8",
    );
    const splitAt = Math.floor(plaintext.byteLength / 2);
    const chunks = [plaintext.subarray(0, splitAt), plaintext.subarray(splitAt)];
    const encryptedChunks = chunks.map((chunk) => encryptBytesWithKey(sender.key, chunk));

    const upload = async (index: number) => {
      const ciphertext = encryptedChunks[index]!;
      const digest = sha256Hex(ciphertext);
      await receiveDirectChunk({
        sessionId: connection.sessionId,
        index,
        sha256: digest,
        signature: testSignature(sender.key, `chunk:${connection.sessionId}:${index}:${digest}`),
        readBytes: async () => ciphertext,
      });
    };
    await upload(0);
    await upload(0); // an identical retry is idempotent

    const manifestBase = {
      totalChunks: chunks.length,
      totalBytes: plaintext.byteLength,
      sha256: createHash("sha256").update(plaintext).digest("hex"),
    };
    const manifest = {
      ...manifestBase,
      signature: testSignature(
        sender.key,
        `finalize:${connection.sessionId}:${manifestBase.totalChunks}:${manifestBase.totalBytes}:${manifestBase.sha256}`,
      ),
    };
    await expect(finalizeDirectChunkUpload(connection.sessionId, manifest)).rejects.toMatchObject({
      code: "MISSING_CHUNK",
    } satisfies Partial<TransferStoreError>);
    expect((await getSession(connection.sessionId))?.status).toBe("uploading");

    await upload(1);
    await expect(finalizeDirectChunkUpload(connection.sessionId, manifest)).rejects.toThrow(
      InvalidTransferFileError,
    );
    expect((await getSession(connection.sessionId))?.status).toBe("failed");
  });

  it("binds the destructive restore mode to the destination session", async () => {
    await clearDirectReceiveSessionsForTest();
    const created = await createDirectReceiveSession({
      apiBase: "https://new.example/api/",
      mode: "merge",
    });
    const connection = decodeDirectTransferCode(created.code);
    const sender = testSender(connection);

    await expect(
      initializeDirectChunkUpload({
        version: 1,
        sessionId: connection.sessionId,
        mode: "wipe",
        senderPublicKey: sender.publicKey,
        proof: encryptWithKey(
          sender.key,
          JSON.stringify({
            version: 1,
            sessionId: connection.sessionId,
            mode: "wipe",
            authorizationToken: connection.token,
          }),
        ),
      }),
    ).rejects.toThrow(DirectTransferSessionError);
    expect((await getSession(connection.sessionId))?.status).toBe("ready");
  });

  it("lets an authenticated source restart with a fresh key without mixing chunks", async () => {
    await clearDirectReceiveSessionsForTest();
    const created = await createDirectReceiveSession({
      apiBase: "https://new.example/api/",
      mode: "merge",
    });
    const connection = decodeDirectTransferCode(created.code);
    const first = testSender(connection);
    const second = testSender(connection);
    const initialize = (sender: ReturnType<typeof testSender>) =>
      initializeDirectChunkUpload({
        version: 1,
        sessionId: connection.sessionId,
        mode: connection.mode,
        senderPublicKey: sender.publicKey,
        proof: encryptWithKey(
          sender.key,
          JSON.stringify({
            version: 1,
            sessionId: connection.sessionId,
            mode: connection.mode,
            authorizationToken: connection.token,
          }),
        ),
      });

    await initialize(first);
    const ciphertext = encryptBytesWithKey(first.key, Buffer.from("first attempt"));
    const digest = sha256Hex(ciphertext);
    await receiveDirectChunk({
      sessionId: connection.sessionId,
      index: 0,
      sha256: digest,
      signature: testSignature(first.key, `chunk:${connection.sessionId}:0:${digest}`),
      readBytes: async () => ciphertext,
    });
    expect(await listChunkMetadata(connection.sessionId)).toHaveLength(1);

    await initialize(second);
    expect(await getSession(connection.sessionId)).toMatchObject({
      status: "uploading",
      senderPublicKey: second.publicKey,
    });
    expect(await listChunkMetadata(connection.sessionId)).toEqual([]);
  });

  it("recovers an abandoned finalizer lease without letting the old worker win", async () => {
    await clearDirectReceiveSessionsForTest();
    const upload = await createFileUpload({ ownerUserId: "user_1", size: 4 });
    const writable = await getSession(upload.uploadId);
    const abandoned = await claimSession(writable!);

    await db
      .update(schema.dataTransferSession)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.dataTransferSession.id, upload.uploadId));

    const recovered = await getSession(upload.uploadId);
    expect(recovered).toMatchObject({ status: "uploading", claimToken: null });
    const replacement = await claimSession(recovered!);
    expect(replacement.claimToken).not.toBe(abandoned.claimToken);

    // A late catch/finally from the dead worker must not release the new claim.
    await releaseSessionClaim(abandoned);
    expect(await getSession(upload.uploadId)).toMatchObject({
      status: "consuming",
      claimToken: replacement.claimToken,
    });
    await releaseSessionClaim(replacement);
  });

  it("returns a committed result when the source retries with the same receive code", async () => {
    await clearDirectReceiveSessionsForTest();
    const created = await createDirectReceiveSession({
      apiBase: "https://new.example/api/",
      mode: "merge",
    });
    const connection = decodeDirectTransferCode(created.code);
    const result = {
      mode: "merge" as const,
      rowsRestored: 12,
      secretsRehydrated: 3,
      secretsSkipped: false,
      localPathProjects: [],
    };
    await db
      .update(schema.dataTransferSession)
      .set({ status: "complete", result })
      .where(eq(schema.dataTransferSession.id, connection.sessionId));

    const sender = testSender(connection);
    const initialized = await initializeDirectChunkUpload({
      version: 1,
      sessionId: connection.sessionId,
      mode: connection.mode,
      senderPublicKey: sender.publicKey,
      proof: encryptWithKey(
        sender.key,
        JSON.stringify({
          version: 1,
          sessionId: connection.sessionId,
          mode: connection.mode,
          authorizationToken: connection.token,
        }),
      ),
    });

    expect(initialized.result).toEqual(result);
  });

  it("retains an authenticated file upload when finalization can be retried", async () => {
    await clearDirectReceiveSessionsForTest();
    const bytes = Buffer.from(JSON.stringify({ kind: "not-an-openship-export" }), "utf8");
    const upload = await createFileUpload({ ownerUserId: "user_1", size: bytes.byteLength });
    await uploadFileChunk({
      uploadId: upload.uploadId,
      ownerUserId: "user_1",
      index: 0,
      sha256: sha256Hex(bytes),
      readBytes: async () => bytes,
    });

    const finalize = () =>
      finalizeFileUpload({
        uploadId: upload.uploadId,
        ownerUserId: "user_1",
        mode: "merge",
      });
    await expect(finalize()).rejects.toThrow(InvalidTransferFileError);
    expect((await getSession(upload.uploadId))?.status).toBe("uploading");
    await expect(finalize()).rejects.toThrow(InvalidTransferFileError);
  });

  it("authenticates chunk metadata before reading a large request body", async () => {
    await clearDirectReceiveSessionsForTest();
    const created = await createDirectReceiveSession({
      apiBase: "https://new.example/api/",
      mode: "merge",
    });
    const connection = decodeDirectTransferCode(created.code);
    const sender = testSender(connection);
    await initializeDirectChunkUpload({
      version: 1,
      sessionId: connection.sessionId,
      mode: connection.mode,
      senderPublicKey: sender.publicKey,
      proof: encryptWithKey(
        sender.key,
        JSON.stringify({
          version: 1,
          sessionId: connection.sessionId,
          mode: connection.mode,
          authorizationToken: connection.token,
        }),
      ),
    });
    const readBytes = vi.fn(async () => Buffer.alloc(8_000_000));

    await expect(
      receiveDirectChunk({
        sessionId: connection.sessionId,
        index: 0,
        sha256: "0".repeat(64),
        signature: "0".repeat(64),
        readBytes,
      }),
    ).rejects.toThrow("signature");
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("validates a decrypted credential bundle before the first restore operation", async () => {
    const file = {
      kind: "openship-instance-export",
      envelopeVersion: 1,
      dump: { scope: { kind: "instance" }, tables: {} },
    } as unknown as DataTransferFile;
    await expect(
      importPreparedInstance({
        file,
        secrets: {
          version: 1,
          entries: [{ table: "env_var", id: "1", column: "value", scheme: "scalar", value: 42 }],
        } as never,
        mode: "wipe",
      }),
    ).rejects.toThrow(InvalidTransferFileError);

    await expect(
      importPreparedInstance({
        file,
        secrets: {
          version: 1,
          entries: [
            {
              table: "env_var",
              id: "1",
              column: "value",
              scheme: "map",
              map: { VALUE: "secret" },
            },
          ],
        },
        mode: "wipe",
      }),
    ).rejects.toThrow("does not match the destination schema");
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
    const columns = SECRET_COLUMNS.filter((entry) => entry.sqlName === "servers").map((entry) => [
      entry.column,
      entry.scheme,
    ]);

    expect(columns).toEqual([
      ["sshPassword", "enc1"],
      ["sshPrivateKey", "enc1"],
      ["sshKeyPassphrase", "enc1"],
    ]);
  });
});

describe("dependency-safe export filtering (#656)", () => {
  it("summarizes core and each optional history group for the pre-export UI", () => {
    expect(
      summarizeExportCounts({
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
      }),
    ).toEqual({
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
    expect(() => resolveExportSelection({ history: ["servers" as never] })).toThrow(
      InvalidExportSelectionError,
    );
  });
});
