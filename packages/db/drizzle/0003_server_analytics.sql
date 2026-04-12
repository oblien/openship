CREATE TABLE IF NOT EXISTS "server_analytics" (
    "id" text PRIMARY KEY NOT NULL,
    "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
    "domain" text NOT NULL,
    "minute" integer NOT NULL,
    "requests" integer NOT NULL DEFAULT 0,
    "unique_requests" integer NOT NULL DEFAULT 0,
    "bandwidth_in" integer NOT NULL DEFAULT 0,
    "bandwidth_out" integer NOT NULL DEFAULT 0,
    "response_time" real NOT NULL DEFAULT 0,
    "countries" jsonb,
    "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "server_analytics_geo" (
    "id" text PRIMARY KEY NOT NULL,
    "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
    "domain" text NOT NULL,
    "day" text NOT NULL,
    "countries" jsonb NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_analytics_server_domain_minute" ON "server_analytics" ("server_id", "domain", "minute");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_analytics_domain_minute" ON "server_analytics" ("domain", "minute");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_analytics_geo_server_domain_day" ON "server_analytics_geo" ("server_id", "domain", "day");
