import { AffiliateOperationSchemas, AppError } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createIdentityAuthorization } from "./identity-authorization";
import {
  createScopedOperations,
  type PlatformScopedOperations,
  type ScopedServices,
} from "./resource-operations";

export interface AffiliateDependencies {
  collection: ScopedServices<typeof AffiliateOperationSchemas>;
}
export type PlatformAffiliateOperations = PlatformScopedOperations<
  typeof AffiliateOperationSchemas
>;
export function createAffiliateOperations(
  authorization: Authorization,
  deps?: AffiliateDependencies,
): PlatformAffiliateOperations {
  const identity = createIdentityAuthorization(authorization);
  return createScopedOperations(
    AffiliateOperationSchemas,
    {
      ...identity,
      async authorize(ctx, input) {
        // A project/workspace integration is not authority over its owner's personal earnings.
        if (ctx.tokenScope || ctx.credential?.organizationId)
          throw new AppError(
            "Use your account session to manage affiliate earnings",
            403,
            "AFFILIATE_ACCOUNT_REQUIRED",
          );
        return identity.authorize(ctx, input);
      },
    },
    "billing",
    deps?.collection,
  );
}
