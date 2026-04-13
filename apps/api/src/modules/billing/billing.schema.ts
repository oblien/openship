import { z } from "zod";

export const createSubscriptionSchema = z.object({
  planId: z.enum(["pro", "team"]),
  interval: z.enum(["monthly", "annual"]),
});

export const updateSubscriptionSchema = z.object({
  planId: z.enum(["free", "pro", "team"]),
});
