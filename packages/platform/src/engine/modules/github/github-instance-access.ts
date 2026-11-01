import type { ExecutionContext } from "../../../context";
import { instanceAuthorization } from "../../lib/instance-authorization";

/** A fixed tenant's ownership does not confer the embedding host's Git identity. */
export async function mayUseInstanceGitIdentity(ctx: ExecutionContext): Promise<boolean> {
  return ctx.scopeMode !== "fixed" || instanceAuthorization.allows(ctx, "read");
}
