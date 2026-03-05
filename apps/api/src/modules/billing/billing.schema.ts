import { z } from "zod";

export const createSubscriptionSchema = z.object({
  planId: z.enum(["free", "pro", "team"]),
});

export const updateSubscriptionSchema = z.object({
  planId: z.enum(["free", "pro", "team"]),
});
