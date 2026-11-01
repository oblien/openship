-- Actions was not sold under the unused fixed execution-time ledger.
-- Deposits and payment history remain intact; usage is owned by Oblien.
DROP TABLE "action_charge";
--> statement-breakpoint
ALTER TABLE "action_budget" DROP CONSTRAINT "action_budget_amounts_check";
--> statement-breakpoint
ALTER TABLE "action_budget" DROP COLUMN "spent_units", DROP COLUMN "reserved_units", ADD COLUMN "runner_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "action_budget" ADD CONSTRAINT "action_budget_amounts_check" CHECK ("funded_units" BETWEEN 0 AND 9007199254740991 AND "runner_version" >= 0);
--> statement-breakpoint
ALTER TABLE "action_runner" ADD COLUMN "cloud_profile_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "action_runner_cloud_profile_unique" ON "action_runner" ("cloud_pool_id", "cloud_profile_id");
--> statement-breakpoint
ALTER TABLE "action_runner" ADD CONSTRAINT "action_runner_cloud_profile_check" CHECK ("cloud_profile_id" IS NULL OR "cloud_pool_id" IS NOT NULL);
