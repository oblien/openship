import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../context";

/** Token grants never promote the owning user's actual organization role. */
export async function requireOrganizationAdmin(ctx: ExecutionContext): Promise<void> {
  const membership = await repos.member.find(ctx.organizationId, ctx.userId);
  if (!membership || !["owner", "admin"].includes(membership.role ?? ""))
    throw new AppError("Requires admin role", 403, "INSUFFICIENT_ROLE");
}
