/**
 * Reconcile process state after a whole-instance database import commits.
 *
 * The restore transaction is atomic, but several deliberately short-lived
 * process caches sit above the database. A wipe can replace the identities,
 * organizations, credentials, servers and instance settings those caches were
 * derived from. Leaving even one old value alive creates a split-brain process:
 * the database is new while requests still act on the previous instance.
 *
 * Keep this as the one post-commit boundary used by every import transport.
 * None of these best-effort refreshes may turn an already committed restore into
 * a reported failure; callers cannot safely retry an operation that did commit.
 */

import { withTimeout } from "@repo/core";

import { clearAuthModeCache } from "./auth-mode";
import { clearBoxOwningOrgCache } from "./box-org";
import { clearAllCacheStores } from "./cache-store";
import { clearHostControlCache, syncHostControlOverride } from "./host-control";
import { invalidateLocalUserCache } from "./local-user";
import { invalidateInstanceTransportCache, invalidatePlatformTransport } from "./mail";
import { invalidateMcpSigningKeyCache } from "./mcp-oidc-keys";
import { clearProductModeCache } from "./product-mode";
import { invalidateSelfAppPublicUrl } from "./public-url";
import { sshManager } from "./ssh-manager";
import { clearMailPortReachabilityCache } from "../modules/mail/mail-port-reachability.service";
import { clearServiceVolumeSizeCache } from "../modules/services/service.service";

type RefreshFailure = { name: string; error: unknown };
const ASYNC_RECONCILE_TIMEOUT_MS = 10_000;

/** Run after, and only after, the restore transaction has committed. */
export async function reconcileRuntimeStateAfterImport(): Promise<void> {
  const failures: RefreshFailure[] = [];
  const run = (name: string, operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      failures.push({ name, error });
    }
  };

  run("local user", invalidateLocalUserCache);
  run("auth mode", clearAuthModeCache);
  run("product mode", clearProductModeCache);
  run("host control", clearHostControlCache);
  run("box owner", clearBoxOwningOrgCache);
  run("self-app URL", invalidateSelfAppPublicUrl);
  run("instance SMTP", invalidateInstanceTransportCache);
  run("platform SMTP", () => invalidatePlatformTransport());
  run("MCP signing key", invalidateMcpSigningKeyCache);
  run("SSH connections", () => sshManager.invalidate());
  run("mail reachability", clearMailPortReachabilityCache);
  run("service volume sizes", clearServiceVolumeSizeCache);

  const asyncRefreshes = await Promise.allSettled([
    withTimeout(
      clearAllCacheStores(),
      ASYNC_RECONCILE_TIMEOUT_MS,
      "Timed out clearing shared runtime caches after database import",
    ),
    withTimeout(
      syncHostControlOverride(),
      ASYNC_RECONCILE_TIMEOUT_MS,
      "Timed out synchronizing host-control state after database import",
    ),
  ]);
  const names = ["shared cache stores", "host-control adapter"];
  asyncRefreshes.forEach((result, index) => {
    if (result.status === "rejected") {
      failures.push({ name: names[index]!, error: result.reason });
    }
  });

  if (failures.length > 0) {
    console.error(
      "[data-transfer] database import committed, but runtime-state reconciliation was incomplete:",
      failures,
    );
  }
}
