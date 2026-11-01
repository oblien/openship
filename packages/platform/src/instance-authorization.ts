import { AppError, ForbiddenError, UnauthorizedError } from "@repo/core";
import type { ExecutionContext } from "./context";

export interface InstanceAuthorizationDependencies {
  /** Must read the persisted instance role, independently of any organization. */
  findUserRole(userId: string): Promise<string | null | undefined>;
  now?: () => number;
}

/** Instance authority is independent from organization ownership and resource grants. */
export function createInstanceAuthorization(deps: InstanceAuthorizationDependencies) {
  const now = deps.now ?? Date.now;

  async function allows(ctx: ExecutionContext, action: "read" | "write" = "write") {
    if (action !== "read" && action !== "write") return false;
    const expiresAt = ctx.credential?.expiresAt;
    if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= now())) return false;
    // Bound credentials cannot exercise whole-instance authority, even when
    // they belong to an administrator. Neither scope nor grants can widen it.
    if (ctx.tokenScope || ctx.credential?.organizationId) return false;
    if (ctx.credential?.readOnly && action !== "read") return false;
    return (await deps.findUserRole(ctx.userId)) === "admin";
  }

  async function assert(ctx: ExecutionContext, action: "read" | "write" = "write") {
    const expiresAt = ctx.credential?.expiresAt;
    if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= now()))
      throw new UnauthorizedError("Identity has expired");
    if (ctx.credential?.readOnly && action !== "read")
      throw new AppError("This access token is read-only", 403, "TOKEN_READ_ONLY");
    if (!(await allows(ctx, action)))
      throw new ForbiddenError("Requires an instance administrator");
  }

  return Object.freeze({ allows, assert });
}

export type InstanceAuthorization = ReturnType<typeof createInstanceAuthorization>;
