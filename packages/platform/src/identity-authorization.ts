import { AppError } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { freezeContext } from "./context";

/** Refresh identity for account operations whose service applies a more specific
 * policy than a resource grant: invitation recipients, Git paths, or self-care. */
export function createIdentityAuthorization(authorization: Authorization): Authorization {
  return {
    ...authorization,
    async authorize(ctx, input) {
      if (ctx.credential?.readOnly && input.action !== "read")
        throw new AppError("This access token is read-only", 403, "TOKEN_READ_ONLY");
      const current = await authorization.resolveScope({
        user: ctx.user, sessionId: ctx.sessionId, sessionKind: ctx.sessionKind, principalKind: ctx.principalKind,
        tokenScope: ctx.tokenScope, credential: ctx.credential,
      }, ctx.organizationId);
      return freezeContext({ ...ctx, role: current.role, membershipId: current.membershipId });
    },
  };
}
