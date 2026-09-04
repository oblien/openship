import { describe, expect, it, vi } from "vitest";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { db, eq, schema } from "@repo/db";

const { TEST_SECRET } = vi.hoisted(() => ({
  TEST_SECRET: "test-secret-for-better-auth-transfer-codec",
}));

vi.mock("../../../config/env", () => ({
  env: { BETTER_AUTH_SECRET: TEST_SECRET, CLOUD_MODE: false },
}));

vi.mock("../migration/migration-lock", () => ({
  withMigrationLock: async <T>(fn: () => Promise<T>) => fn(),
  reassertMigrationLockAfterRestore: async () => {},
}));

import { extractPlaintext, sealForInstance } from "./secret-codec";
import type { SecretColumn } from "./secret-registry";
import { importPreparedInstance, InvalidTransferFileError } from "./import.service";
import type { DataTransferFile, SecretBundle } from "./types";

function betterAuthSpec(column: "secret" | "backupCodes"): SecretColumn {
  return {
    sqlName: "two_factor",
    table: {} as never,
    pk: {} as never,
    column,
    scheme: "better-auth",
  } as SecretColumn;
}

function transferFile(tables: Record<string, Array<Record<string, unknown>>>): DataTransferFile {
  return {
    kind: "openship-instance-export",
    envelopeVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceDriver: "pglite",
    secrets: null,
    dump: {
      formatVersion: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      sourceDriver: "pglite",
      scope: { kind: "instance" },
      tables,
    },
  };
}

describe("Better Auth transfer secret codec", () => {
  it.each([
    ["secret", "raw-totp-secret-material-012345"],
    ["backupCodes", JSON.stringify(["AbCdE-12345", "fGhIj-67890"])],
  ] as const)("round-trips two_factor.%s through plaintext", async (column, plaintext) => {
    const stored = await symmetricEncrypt({ key: TEST_SECRET, data: plaintext });
    const entry = await extractPlaintext(betterAuthSpec(column), "two_factor_1", stored);

    expect(entry).toEqual({
      table: "two_factor",
      id: "two_factor_1",
      column,
      scheme: "better-auth",
      value: plaintext,
    });

    const resealed = await sealForInstance(betterAuthSpec(column), entry!) as string;
    await expect(symmetricDecrypt({ key: TEST_SECRET, data: resealed })).resolves.toBe(plaintext);
  });

  it.each([null, undefined, "", 123, {}, []])(
    "keeps empty or non-string Better Auth value %j absent",
    async (cell) => {
      await expect(extractPlaintext(betterAuthSpec("secret"), "two_factor_1", cell)).resolves.toBeNull();
    },
  );

  it("accepts the better-auth scheme in a serialized transfer bundle", async () => {
    const file: DataTransferFile = {
      kind: "openship-instance-export",
      envelopeVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceDriver: "pglite",
      secrets: null,
      dump: {
        formatVersion: 1,
        exportedAt: "2026-01-01T00:00:00.000Z",
        sourceDriver: "pglite",
        scope: { kind: "instance" },
        tables: {},
      },
    };
    const secrets: SecretBundle = {
      version: 1,
      entries: [
        {
          table: "not_registered",
          id: "row_1",
          column: "secret",
          scheme: "better-auth",
          value: "portable plaintext",
        },
      ],
    };

    await expect(importPreparedInstance({ file, secrets, mode: "merge" })).resolves.toMatchObject({
      mode: "merge",
      rowsRestored: 0,
      secretsRehydrated: 0,
    });
  });

  it("rejects an empty Better Auth secret before restoring data", async () => {
    const file = transferFile({});
    const secrets: SecretBundle = {
      version: 1,
      entries: [
        {
          table: "two_factor",
          id: "two_factor_1",
          column: "secret",
          scheme: "better-auth",
          value: "",
        },
      ],
    };

    await expect(importPreparedInstance({ file, secrets, mode: "merge" })).rejects.toBeInstanceOf(
      InvalidTransferFileError,
    );
  });

  it.each(["not-json", "{}", "[]", JSON.stringify([""])])(
    "rejects malformed Better Auth backup codes %s before restoring data",
    async (value) => {
      const file = transferFile({});
      const secrets: SecretBundle = {
        version: 1,
        entries: [
          {
            table: "two_factor",
            id: "two_factor_1",
            column: "backupCodes",
            scheme: "better-auth",
            value,
          },
        ],
      };

      await expect(importPreparedInstance({ file, secrets, mode: "merge" })).rejects.toBeInstanceOf(
        InvalidTransferFileError,
      );
    },
  );
});

describe("incomplete imported two-factor state", () => {
  const userRow = {
    id: "usr_imported_2fa",
    name: "Imported User",
    email: "imported-2fa@example.com",
    emailVerified: true,
    twoFactorEnabled: true,
    role: "user",
    autoProvisioned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const factorRow = {
    id: "two_factor_imported",
    userId: userRow.id,
    secret: "source-instance-ciphertext",
    backupCodes: "source-instance-backup-ciphertext",
  };

  it("removes an undecryptable restored factor and disables its user", async () => {
    await importPreparedInstance({
      file: transferFile({ user: [{ ...userRow }], two_factor: [{ ...factorRow }] }),
      secrets: null,
      mode: "wipe",
    });

    const restoredFactors = await db
      .select()
      .from(schema.twoFactor)
      .where(eq(schema.twoFactor.id, factorRow.id));
    const [restoredUser] = await db
      .select({ twoFactorEnabled: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, userRow.id));

    expect(restoredFactors).toHaveLength(0);
    expect(restoredUser?.twoFactorEnabled).toBe(false);
  });

  it("does not normalize a destination factor during merge", async () => {
    const destinationUser = {
      ...userRow,
      id: "usr_destination_2fa",
      email: "destination-2fa@example.com",
    };
    const destinationFactor = {
      ...factorRow,
      id: "two_factor_destination",
      userId: destinationUser.id,
      secret: "destination-secret-ciphertext",
      backupCodes: "destination-backup-ciphertext",
    };
    await db.insert(schema.user).values({
      ...destinationUser,
      createdAt: new Date(destinationUser.createdAt),
      updatedAt: new Date(destinationUser.updatedAt),
    });
    await db.insert(schema.twoFactor).values(destinationFactor);

    await importPreparedInstance({
      file: transferFile({
        user: [{ ...destinationUser, name: "Source Name" }],
        two_factor: [{ ...destinationFactor, secret: "source-secret-ciphertext" }],
      }),
      secrets: null,
      mode: "merge",
    });

    const [preserved] = await db
      .select()
      .from(schema.twoFactor)
      .where(eq(schema.twoFactor.id, destinationFactor.id));
    const [preservedUser] = await db
      .select({ twoFactorEnabled: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, destinationUser.id));

    expect(preserved?.secret).toBe(destinationFactor.secret);
    expect(preserved?.backupCodes).toBe(destinationFactor.backupCodes);
    expect(preservedUser?.twoFactorEnabled).toBe(true);
  });

  it("preserves a destination factor when the source uses another factor id", async () => {
    const destinationUser = {
      ...userRow,
      id: "usr_destination_factor_identity",
      email: "destination-factor-identity@example.com",
    };
    const destinationFactor = {
      ...factorRow,
      id: "two_factor_destination_identity",
      userId: destinationUser.id,
      secret: "destination-identity-secret",
      backupCodes: "destination-identity-backup-codes",
    };
    await db.insert(schema.user).values({
      ...destinationUser,
      createdAt: new Date(destinationUser.createdAt),
      updatedAt: new Date(destinationUser.updatedAt),
    });
    await db.insert(schema.twoFactor).values(destinationFactor);

    await importPreparedInstance({
      file: transferFile({
        user: [{ ...destinationUser, name: "Source Name" }],
        two_factor: [{ ...destinationFactor, id: "two_factor_source_identity" }],
      }),
      secrets: null,
      mode: "merge",
    });

    const factors = await db
      .select()
      .from(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, destinationUser.id));
    const [preservedUser] = await db
      .select({ twoFactorEnabled: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, destinationUser.id));

    expect(factors).toEqual([expect.objectContaining(destinationFactor)]);
    expect(preservedUser?.twoFactorEnabled).toBe(true);
  });

  it("does not add a complete source factor when the destination user already has one", async () => {
    const destinationUser = {
      ...userRow,
      id: "usr_destination_complete_factor",
      email: "destination-complete-factor@example.com",
    };
    const destinationFactor = {
      ...factorRow,
      id: "two_factor_destination_complete",
      userId: destinationUser.id,
      secret: "destination-complete-secret",
      backupCodes: "destination-complete-backup-codes",
    };
    const sourceFactorId = "two_factor_source_complete";
    await db.insert(schema.user).values({
      ...destinationUser,
      createdAt: new Date(destinationUser.createdAt),
      updatedAt: new Date(destinationUser.updatedAt),
    });
    await db.insert(schema.twoFactor).values(destinationFactor);

    await importPreparedInstance({
      file: transferFile({
        user: [{ ...destinationUser, name: "Source Name" }],
        two_factor: [{ ...destinationFactor, id: sourceFactorId }],
      }),
      secrets: {
        version: 1,
        entries: [
          {
            table: "two_factor",
            id: sourceFactorId,
            column: "secret",
            scheme: "better-auth",
            value: "source-complete-secret",
          },
          {
            table: "two_factor",
            id: sourceFactorId,
            column: "backupCodes",
            scheme: "better-auth",
            value: JSON.stringify(["ABCDE-12345"]),
          },
        ],
      },
      mode: "merge",
    });

    const factors = await db
      .select()
      .from(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, destinationUser.id));

    expect(factors).toEqual([expect.objectContaining(destinationFactor)]);
  });
});
