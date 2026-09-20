import { DnsOperationSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import { createScopedOperations, type ScopedServices, type PlatformScopedOperations } from "./resource-operations";

export type PlatformDnsOperations = PlatformScopedOperations<typeof DnsOperationSchemas>;
export interface DnsDependencies {
  operations: ScopedServices<typeof DnsOperationSchemas>;
  /** Re-read actual membership; token scopes never confer an administrator role. */
  requireAdmin(ctx: ExecutionContext): Promise<void>;
}
export function createDnsOperations(authorization: Authorization, deps?: DnsDependencies): PlatformDnsOperations {
  return createScopedOperations(DnsOperationSchemas, authorization, "settings", deps && {
    ...deps.operations,
    async addCredential(ctx, input) {
      await deps.requireAdmin(ctx);
      return deps.operations.addCredential(ctx, input);
    },
    async removeCredential(ctx, id) {
      await deps.requireAdmin(ctx);
      return deps.operations.removeCredential(ctx, id);
    },
  });
}
