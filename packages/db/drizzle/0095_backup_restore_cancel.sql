-- Make "cancel a restore" durable.
--
-- Cancel used to be advisory at best: it refused `applying` outright, and for
-- `preparing` it wrote the row while the running phase carried on and
-- overwrote it with `prepared` — so the operator saw a cancel that never
-- happened. Cancelling has to survive the phase it interrupts, and the node
-- receiving the request is not guaranteed to be the node running the apply, so
-- the in-process AbortController cannot be the only signal.
--
-- `cancel_requested_at` is also the force-terminal window: an `applying` row
-- whose request is older than a couple of minutes (operator pressed cancel,
-- waited, pressed again) can be force-terminaled without a second endpoint,
-- which is the only escape from a wedged row that otherwise blocks project
-- deletion.
ALTER TABLE "backup_restore" ADD COLUMN IF NOT EXISTS "cancel_requested" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_restore" ADD COLUMN IF NOT EXISTS "cancel_requested_at" timestamp;
--> statement-breakpoint
ALTER TABLE "backup_restore" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp;
