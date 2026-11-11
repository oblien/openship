import { ReferralOperationSchemas, AppError } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createIdentityAuthorization } from "./identity-authorization";
import {
  createScopedOperations,
  type PlatformScopedOperations,
  type ScopedServices,
} from "./resource-operations";

export interface ReferralDependencies {
  collection: ScopedServices<typeof ReferralOperationSchemas>;
}
export type PlatformReferralOperations = PlatformScopedOperations<
  typeof ReferralOperationSchemas
>;
export function createReferralOperations(
  authorization: Authorization,
  deps?: ReferralDependencies,
): PlatformReferralOperations {
  const identity = createIdentityAuthorization(authorization);
  return createScopedOperations(
    ReferralOperationSchemas,
    {
      ...identity,
      async authorize(ctx, input) {
        // A project/workspace integration is not authority over its owner's personal earnings.
        if (ctx.tokenScope || ctx.credential?.organizationId)
          throw new AppError(
            "Use your account session to manage referral earnings",
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
