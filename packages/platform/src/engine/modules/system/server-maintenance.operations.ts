import { OperationError } from "@repo/contracts";
import { repos } from "@repo/db";
import type { RateLimitConfig } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import type { ServerDependencies } from "../../../servers";
import { withOpenRestyRouting } from "../../lib/openresty-paths";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { assertServerExecution, requireSelfHostedServer } from "./server-access";
import { scanServer, applyServerModule } from "./server-modules.service";

function isValidCidr(cidr: string): boolean {
  return /^[\da-fA-F.:]+\/\d{1,3}$/.test(cidr) && cidr.length <= 50;
}
function rateLimitFailure(error: string, update = false): never {
  throw new OperationError(error, 500, "SERVER_RATE_LIMIT_FAILED", update ? { success: false } : undefined);
}

export const serverMaintenanceResources: Pick<ServerDependencies["resources"],
  "listModules" | "scanModules" | "applyModule" | "getRateLimit" | "updateRateLimit"> = {
  async listModules(ctx, id) {
    await requireSelfHostedServer(ctx, id);
    return repos.serverModuleStatus.listByServer(id);
  },
  async scanModules(ctx, id) {
    const server = await requireSelfHostedServer(ctx, id);
    await assertServerExecution(server);
    const modules = await scanServer(server).catch((err: unknown) => {
      throw new Error(`scan failed: ${(err as Error).message}`);
    });
    audit.recordAsync(operationAuditContext(ctx), { eventType: "server:write", resourceType: "server", resourceId: id });
    return { ok: true, modules };
  },
  async applyModule(ctx, id, input) {
    const server = await requireSelfHostedServer(ctx, id);
    await assertServerExecution(server);
    // Explicit application includes consent-tier steps. A failed step is a result.
    const result = await applyServerModule(server, input.module, "all");
    audit.recordAsync(operationAuditContext(ctx), { eventType: "server:write", resourceType: "server", resourceId: id });
    return result;
  },
  async getRateLimit(ctx, id) {
    const server = await requireSelfHostedServer(ctx, id);
    await assertServerExecution(server);
    let config: RateLimitConfig | null;
    try {
      config = await withOpenRestyRouting(id, routing => routing.getRateLimitConfig());
    } catch (err) {
      return rateLimitFailure(`Failed to read OpenResty rate limit config: ${safeErrorMessage(err)}`);
    }
    if (!config) return rateLimitFailure("Failed to parse OpenResty rate limit config");
    return { config };
  },
  async updateRateLimit(ctx, id, body) {
    const server = await requireSelfHostedServer(ctx, id);
    await assertServerExecution(server);
    let isRemoving = false;
    try {
      const current = await withOpenRestyRouting(id, routing => routing.getRateLimitConfig());
      if (!current) return rateLimitFailure("Failed to parse current OpenResty rate limit config", true);
      const nextConfig: RateLimitConfig = {
        rps: typeof body.rps === "number" ? Math.max(0, Math.floor(body.rps)) : current.rps,
        burst: typeof body.burst === "number" ? Math.max(0, Math.floor(body.burst)) : current.burst,
        whitelist: Array.isArray(body.whitelist) ? body.whitelist.filter(isValidCidr) : current.whitelist,
      };
      isRemoving = nextConfig.rps <= 0;
      await withOpenRestyRouting(id, routing => routing.applyRateLimit(nextConfig));
      const config = await withOpenRestyRouting(id, routing => routing.getRateLimitConfig());
      if (!config) return rateLimitFailure("OpenResty updated, but the live rate limit config could not be verified afterward.", true);
      audit.recordAsync(operationAuditContext(ctx), { eventType: "server:admin", resourceType: "server", resourceId: id });
      return { success: true, config };
    } catch (err) {
      if (err instanceof OperationError) throw err;
      const msg = safeErrorMessage(err);
      return rateLimitFailure(isRemoving
        ? `Failed to remove rate limit from OpenResty: ${msg}`
        : `Failed to apply rate limit to OpenResty: ${msg}`, true);
    }
  },
};
