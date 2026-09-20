-- Add ssl_challenge column to domain table for DNS-01 ACME challenge support
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "ssl_challenge" text DEFAULT 'http-01' NOT NULL;
