CREATE TABLE managed_mail_host (
  engine text PRIMARY KEY, hostname text NOT NULL UNIQUE, shared boolean NOT NULL,
  CONSTRAINT managed_mail_host_identity UNIQUE (engine, hostname, shared)
);
--> statement-breakpoint
INSERT INTO managed_mail_host SELECT engine, hostname, false FROM managed_mail_service;
--> statement-breakpoint
ALTER TABLE managed_mail_service
  DROP CONSTRAINT managed_mail_service_engine_key,
  DROP CONSTRAINT managed_mail_service_hostname_key,
  ALTER COLUMN engine DROP NOT NULL,
  ALTER COLUMN hostname DROP NOT NULL,
  ADD COLUMN shared boolean NOT NULL DEFAULT false,
  ADD COLUMN provisioning boolean NOT NULL DEFAULT false,
  ADD COLUMN cloud_server_id text UNIQUE;
--> statement-breakpoint
ALTER TABLE managed_mail_service ADD CONSTRAINT managed_mail_service_host FOREIGN KEY (engine, hostname, shared)
  REFERENCES managed_mail_host (engine, hostname, shared);
--> statement-breakpoint
ALTER TABLE managed_mail_service ADD CONSTRAINT managed_mail_shared_placement CHECK (NOT shared OR placement = 'standard'),
  ADD CONSTRAINT managed_mail_assignment CHECK ((engine IS NOT NULL AND hostname IS NOT NULL) OR
    (engine IS NULL AND hostname IS NULL AND provisioning AND cloud_server_id IS NOT NULL AND placement = 'dedicated'));
--> statement-breakpoint
CREATE UNIQUE INDEX managed_mail_private_engine ON managed_mail_service (engine) WHERE NOT shared;
