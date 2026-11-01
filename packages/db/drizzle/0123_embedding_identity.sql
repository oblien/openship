CREATE TABLE "external_identity" (
  "issuer" text NOT NULL,
  "subject" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("issuer", "subject")
);
--> statement-breakpoint
CREATE TABLE "external_namespace" (
  "issuer" text NOT NULL,
  "key" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "created_at" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("issuer", "key")
);
--> statement-breakpoint
CREATE TABLE "platform_instance" (
  "id" text PRIMARY KEY NOT NULL,
  "instance_id" text NOT NULL,
  "key_fingerprint" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
