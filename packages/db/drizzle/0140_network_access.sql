-- Omitted policies retain the existing full mesh. Empty policies are explicitly isolated.
ALTER TABLE "private_network_config" ADD COLUMN "access" jsonb;
