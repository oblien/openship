-- Durable, bounded staging for browser imports and encrypted instance-to-instance
-- transfers. Sessions survive API worker changes/restarts; chunks cascade away
-- when the short-lived session is cleaned up.
CREATE TABLE "data_transfer_session" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"mode" text,
	"owner_user_id" text,
	"token_hash" text,
	"private_key" text,
	"sender_public_key" text,
	"claim_token" text,
	"expected_bytes" bigint,
	"expected_chunks" integer,
	"result" jsonb,
	"expires_at" timestamp NOT NULL,
	"max_expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_data_transfer_session_kind" CHECK ("kind" IN ('direct', 'file')),
	CONSTRAINT "ck_data_transfer_session_status" CHECK ("status" IN ('ready', 'uploading', 'consuming', 'complete', 'failed')),
	CONSTRAINT "ck_data_transfer_session_mode" CHECK ("mode" IS NULL OR "mode" IN ('wipe', 'merge')),
	CONSTRAINT "ck_data_transfer_session_expected_bytes" CHECK ("expected_bytes" IS NULL OR "expected_bytes" BETWEEN 1 AND 500000000),
	CONSTRAINT "ck_data_transfer_session_expected_chunks" CHECK ("expected_chunks" IS NULL OR "expected_chunks" BETWEEN 1 AND 63)
);
--> statement-breakpoint
CREATE TABLE "data_transfer_chunk" (
	"session_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"bytes" bytea NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_transfer_chunk_session_id_chunk_index_pk" PRIMARY KEY("session_id","chunk_index"),
	CONSTRAINT "ck_data_transfer_chunk_index" CHECK ("chunk_index" BETWEEN 0 AND 62),
	CONSTRAINT "ck_data_transfer_chunk_length" CHECK ("byte_length" BETWEEN 1 AND 8000064),
	CONSTRAINT "ck_data_transfer_chunk_bytes" CHECK (octet_length("bytes") = "byte_length")
);
--> statement-breakpoint
ALTER TABLE "data_transfer_chunk" ADD CONSTRAINT "data_transfer_chunk_session_id_data_transfer_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."data_transfer_session"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "data_transfer_session_expires_idx" ON "data_transfer_session" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "data_transfer_session_owner_idx" ON "data_transfer_session" USING btree ("owner_user_id");
