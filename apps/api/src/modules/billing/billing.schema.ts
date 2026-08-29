import { z } from "zod";
import { PLAN_IDS, PLANS, type PlanTierId } from "@repo/core";

/**
 * Tiers a customer can buy through self-serve Checkout: everything the pricing
 * catalog gives a real monthly price. Free needs no checkout and enterprise is
 * contact-sales, and both are excluded by that rule rather than by name.
 *
 * DERIVED from the catalog, not listed. The hardcoded `["pro", "team"]` this
 * replaces silently rejected every tier added afterwards — the new `starter`
 * ($10) tier was our cheapest paid plan and a checkout request for it 400'd at
 * the schema before reaching any billing code, so the plan was visible,
 * advertised, and unbuyable.
 */
const PURCHASABLE_TIERS = PLAN_IDS.filter(
  (id) => (PLANS[id].price.monthly ?? 0) > 0,
) as [PlanTierId, ...PlanTierId[]];

/**
 * Subscription checkout body. `planTierId` mirrors the catalog-side naming
 * (replaces the legacy `planId` union which only covered paid tiers) — the
 * webhook reads the same key off `metadata.planTierId`, so keep them in sync if
 * you rename.
 */
export const createSubscriptionSchema = z.object({
  planTierId: z.enum(PURCHASABLE_TIERS),
  interval: z.enum(["monthly", "annual"]),
});
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;

/**
 * One-shot top-up checkout body. The webhook handler resolves the
 * pack via `metadata.packId` against the `CREDIT_PACKS` catalog —
 * keep the key name identical here.
 */
export const createTopupSchema = z.object({
  packId: z.string().min(1).max(64),
});
export type CreateTopupInput = z.infer<typeof createTopupSchema>;

