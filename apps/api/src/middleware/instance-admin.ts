/**
 * Instance-level authorization — the gate for WHOLE-INSTANCE operations.
 *
 * Why this exists (GHSA-rwq6-r63g-3c8h): an org-scoped check cannot gate an
 * instance-wide operation, so `requireRole("owner")` never separated privilege
 * on these routes. Two facts compose into a bypass:
 *
 *   1. The org that check resolves is CALLER-SELECTED. `permission.assert`
 *      stashes `scopedOrganizationId` (lib/permission.ts) from
 *      `resolveRequestScopeOrg`, which reads `X-Organization-Id` ahead of the
 *      session org; `requireRole` reads that stash first and unconditionally
 *      (middleware/active-organization.ts).
 *   2. EVERY user is `owner` of an auto-provisioned personal org
 *      `org_<userId>` (lib/provision-user.ts), which `lib/auth.ts` also sets as
 *      their default active org.
 *
 * So any authenticated user satisfied `requireRole("owner")` — no privilege
 * escalation step required. The instance role is a DIFFERENT axis and is not
 * caller-selectable: `user.role === "admin"` holds only for the zero-auth local
 * user, the founding admin promoted from it by `bootstrapAdmin`, and
 * cloud-mirrored users. Better Auth signups and `invite-signup` teammates are
 * role `"user"` (lib/provision-user.ts defaults `role` to `"user"`).
 *
 * INVARIANT — do not break this: these helpers derive NO organization. They must
 * never read `X-Organization-Id`, `scopedOrganizationId`, or
 * `activeOrganizationId`. Reading any of them reintroduces the bypass.
 */

import type { Context, Next } from "hono";
import { ForbiddenError } from "@repo/core";
import { db, schema, eq } from "@repo/db";

import { getRequestContext, type RequestContext } from "../lib/request-context";

const DENIED = "Requires an instance administrator";

/** True when this principal is an admin OF THE INSTANCE (not of any org). */
async function isInstanceAdmin(ctx: RequestContext): Promise<boolean> {
  // A scoped token must never carry instance-takeover capability, whoever owns
  // it — a narrowly-granted PAT reaching a whole-instance export would defeat
  // the point of scoping. Unscoped PATs (how the CLI authenticates) still pass.
  if (ctx.tokenScope) return false;

  const [row] = await db
    .select({ role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, ctx.userId))
    .limit(1);

  return row?.role === "admin";
}

/**
 * Route middleware: 403 unless the caller is an instance administrator.
 *
 * Mount this INSTEAD OF `requireRole("owner")` on any route whose handler acts
 * across the whole instance (every org's data, the host, the control plane).
 */
export function requireInstanceAdmin() {
  return async (c: Context, next: Next) => {
    let ctx: RequestContext;
    try {
      ctx = getRequestContext(c);
    } catch {
      // Route mounted without authMiddleware — fail loud rather than open.
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!(await isInstanceAdmin(ctx))) {
      return c.json({ error: DENIED, code: "INSUFFICIENT_INSTANCE_ROLE" }, 403);
    }

    await next();
  };
}

/**
 * Handler-level form, for defense in depth inside controllers and services so a
 * future route (or an internal caller) can't re-open the hole by forgetting the
 * middleware. Throws ForbiddenError (403).
 */
export async function assertInstanceAdmin(ctx: RequestContext): Promise<void> {
  if (!(await isInstanceAdmin(ctx))) {
    throw new ForbiddenError(DENIED);
  }
}
