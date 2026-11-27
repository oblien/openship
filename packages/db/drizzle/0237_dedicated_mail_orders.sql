ALTER TABLE managed_mail_service
  DROP CONSTRAINT managed_mail_service_organization_id_key,
  DROP CONSTRAINT managed_mail_assignment,
  ADD COLUMN billing_namespace text UNIQUE,
  ADD COLUMN dedicated_order jsonb,
  ADD COLUMN order_state text,
  ADD COLUMN checkout_id text;
--> statement-breakpoint
ALTER TABLE managed_mail_service ADD CONSTRAINT managed_mail_assignment CHECK (
  (engine IS NOT NULL AND hostname IS NOT NULL) OR
  (engine IS NULL AND hostname IS NULL AND provisioning AND placement = 'dedicated'
   AND (cloud_server_id IS NOT NULL OR billing_namespace IS NOT NULL))
), ADD CONSTRAINT managed_mail_order_identity CHECK (
  (billing_namespace IS NULL AND dedicated_order IS NULL AND order_state IS NULL) OR
  (billing_namespace IS NOT NULL AND dedicated_order IS NOT NULL AND order_state IS NOT NULL
   AND order_state IN ('checkout','funded','closed') AND placement = 'dedicated' AND NOT shared)
);
--> statement-breakpoint
CREATE UNIQUE INDEX managed_mail_default_service ON managed_mail_service (organization_id) WHERE billing_namespace IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX managed_mail_pending_order ON managed_mail_service (organization_id) WHERE order_state = 'checkout';
