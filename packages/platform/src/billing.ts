import { AppError, BillingPublicSchemas, BillingOperationSchemas, parseInput, type BillingOperations, type ScopedOperations } from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import { createScopedOperations, presentOperationOutput, type PlatformScopedOperations, type ScopedServices } from "./resource-operations";

export interface BillingDependencies {
  public: { listPlans(input: { locale?: string }): Promise<unknown> | unknown };
  collection: ScopedServices<typeof BillingOperationSchemas>;
}
export type PlatformBillingOperations = PlatformScopedOperations<typeof BillingPublicSchemas> & PlatformScopedOperations<typeof BillingOperationSchemas>;

export function createPublicBillingOperations(deps?: BillingDependencies["public"]): ScopedOperations<typeof BillingPublicSchemas> {
  return Object.freeze({ async listPlans(command = {}) {
    const input = parseInput(BillingPublicSchemas.listPlans.input, command);
    if (!deps) throw new AppError("Billing catalog is not configured", 501, "CAPABILITY_UNAVAILABLE");
    return presentOperationOutput(BillingPublicSchemas.listPlans, await deps.listPlans(input), "billing.listPlans") as Awaited<ReturnType<BillingOperations["listPlans"]>>;
  } });
}
export function createBillingOperations(authorization: Authorization, deps?: BillingDependencies): PlatformBillingOperations {
  const publicOperations = createPublicBillingOperations(deps?.public);
  return Object.freeze({
    ...createScopedOperations(BillingOperationSchemas, authorization, "billing", deps?.collection),
    async listPlans(context: ExecutionContext, input = {}) { return { context, data: await publicOperations.listPlans(input) }; },
  });
}
