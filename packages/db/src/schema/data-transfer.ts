import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Short-lived staging for whole-instance transfers.
 *
 * These rows deliberately live in Postgres instead of process memory: a receive
 * code and its uploaded chunks must resolve on any API worker and survive a
 * process restart. They are excluded from instance exports and removed lazily
 * after expiry.
 */
export const dataTransferSession = pgTable(
  "data_transfer_session",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // direct | file
    status: text("status").notNull().default("ready"),
    mode: text("mode"), // wipe | merge; fixed by a direct receive code
    ownerUserId: text("owner_user_id"), // file-upload sessions only; intentionally no FK
    tokenHash: text("token_hash"), // direct sessions only (sha256 hex)
    privateKey: text("private_key"), // instance-encrypted PKCS#8 X25519 key
    senderPublicKey: text("sender_public_key"),
    claimToken: text("claim_token"), // identifies the current finalizer lease
    expectedBytes: bigint("expected_bytes", { mode: "number" }),
    expectedChunks: integer("expected_chunks"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    expiresAt: timestamp("expires_at").notNull(),
    maxExpiresAt: timestamp("max_expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("data_transfer_session_expires_idx").on(t.expiresAt),
    index("data_transfer_session_owner_idx").on(t.ownerUserId),
    check("ck_data_transfer_session_kind", sql`${t.kind} IN ('direct', 'file')`),
    check(
      "ck_data_transfer_session_status",
      sql`${t.status} IN ('ready', 'uploading', 'consuming', 'complete', 'failed')`,
    ),
    check(
      "ck_data_transfer_session_mode",
      sql`${t.mode} IS NULL OR ${t.mode} IN ('wipe', 'merge')`,
    ),
    check(
      "ck_data_transfer_session_expected_bytes",
      sql`${t.expectedBytes} IS NULL OR ${t.expectedBytes} BETWEEN 1 AND 500000000`,
    ),
    check(
      "ck_data_transfer_session_expected_chunks",
      sql`${t.expectedChunks} IS NULL OR ${t.expectedChunks} BETWEEN 1 AND 63`,
    ),
  ],
);

/** Drizzle has no built-in bytea column; both pg and PGlite accept Uint8Array. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

export const dataTransferChunk = pgTable(
  "data_transfer_chunk",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => dataTransferSession.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    bytes: bytea("bytes").notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.chunkIndex] }),
    check("ck_data_transfer_chunk_index", sql`${t.chunkIndex} BETWEEN 0 AND 62`),
    check("ck_data_transfer_chunk_length", sql`${t.byteLength} BETWEEN 1 AND 8000064`),
    check("ck_data_transfer_chunk_bytes", sql`octet_length(${t.bytes}) = ${t.byteLength}`),
  ],
);
