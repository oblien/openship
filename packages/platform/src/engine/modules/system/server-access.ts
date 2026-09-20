import { AppError, NotFoundError } from "@repo/contracts";
import { repos, type Server } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config";
import { isLocalHostRow } from "../../lib/box-org";
import { assertNativeHostExecution, assertNativeSshSettings } from "../../native/execution-policy";

export { assertNativeSshSettings } from "../../native/execution-policy";

export function assertSelfHosted(): void {
  if (env.CLOUD_MODE) throw new AppError("Not available in cloud mode", 404, "CAPABILITY_UNAVAILABLE");
}

export async function requireSelfHostedServer(ctx: ExecutionContext, id: string): Promise<Server> {
  assertSelfHosted();
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) throw new NotFoundError("Server", id);
  return server;
}

/** Check before best-effort provider catches, so a policy refusal stays explicit. */
export async function assertServerExecution(server: Server): Promise<void> {
  if (process.env.OPENSHIP_NATIVE !== "true") return;
  // Match SSH target selection, including founding-org loopback rows that have
  // not yet been adopted as the canonical local server.
  if (await isLocalHostRow(server)) assertNativeHostExecution();
  else assertNativeSshSettings(server);
}
