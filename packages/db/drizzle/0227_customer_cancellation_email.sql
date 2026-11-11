ALTER TABLE "cloud_customer_email" ADD COLUMN "cancellation" jsonb;
--> statement-breakpoint
ALTER TABLE "cloud_customer_email" DROP CONSTRAINT "cloud_customer_email_kind";
--> statement-breakpoint
ALTER TABLE "cloud_customer_email" ADD CONSTRAINT "cloud_customer_email_kind"
  CHECK ("kind" IN ('signup', 'purchase', 'invoice', 'cancellation'));
