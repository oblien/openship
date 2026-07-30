/**
 * Self-server reconcile — Self-hosted (server-host / "VPS") only.
 *
 * When OpenShip runs ON a server (docker/bare self-host — the `modes` gate below
 * excludes desktop), the host is itself a deployable target. This registers it
 * ONCE as an `isLocal` "This Server" row so it shows up in /servers and becomes
 * a first-class deploy target. Deploys to it resolve to the LOCAL host executor
 * (createHostExecutor), not SSH — see `deployment-runtime.resolveTargetPlatform`.
 *
 * Idempotent, and deliberately callable from BOTH ends of the install:
 *   - the boot hook, for a box that already has an admin, and
 *   - `bootstrap-admin`, the moment the CLI creates that admin.
 * See {@link ensureLocalServerRegistered} for why the hook alone wasn't enough.
 */
import { env } from "../../config/env";
import { repos } from "@repo/db";
import { foundingAdminId } from "../../modules/system/self-app.controller";
import { resolveInstancePublicIp } from "../server-target";
import { registerStartupHook } from "./index";

/**
 * Register this host as the `isLocal` "This Server" deploy target, if it isn't
 * already. Safe to call repeatedly and from any phase of setup.
 *
 * The row is owned by the founding admin's personal org, so it can't be created
 * before that admin exists. On a CLI install the ordering is exactly wrong for a
 * boot-only hook:
 *
 *   compose up → API boots → hook runs, NO admin yet → returns
 *              → CLI calls bootstrap-admin → admin now exists
 *              → CLI calls self-register → the Apps row appears
 *              → nothing re-runs the hook
 *
 * so a freshly installed box showed "No servers yet" (while Openship itself was
 * listed under Apps, which is what made it look arbitrary) until the API happened
 * to restart. "Retry next boot" is fine for a reboot that eventually comes; a
 * fresh install never performs one. Hence the second call site.
 *
 * Returns true when it created the row.
 */
export async function ensureLocalServerRegistered(): Promise<boolean> {
  // Host control off → this box is NOT a deploy target, so don't advertise it as
  // one. Registering it would put a server in the list whose every operation
  // throws, which reads as broken rather than as a policy. (`listServers` hides
  // isLocal rows under the same flag, so this stays consistent either way.)
  const { hostControlDisabled } = await import("@repo/adapters");
  if (hostControlDisabled()) return false;

  const adminId = await foundingAdminId();
  if (!adminId) return false; // no admin/org yet — the bootstrap-admin call will retry
  const organizationId = `org_${adminId}`;

  if (await repos.server.findLocal(organizationId)) return false; // already registered

  // ssh* fields are display-only for an isLocal row (never dialed). Prefer a
  // real address so the servers list reads truthfully AND the DNS A record for a
  // domain deployed here points at the box's public IP rather than loopback.
  // Detected once, here at "ensure this server" — never on a per-request path.
  const displayHost = env.SERVER_IP || env.HOST_DOMAIN || (await resolveInstancePublicIp()) || "127.0.0.1";

  await repos.server.create({
    organizationId,
    name: "This Server",
    sshHost: displayHost,
    isLocal: true,
  });
  console.log(`[self-server] registered this host as a deploy target (${displayHost})`);
  return true;
}

export function registerSelfServerReconcile(): void {
  registerStartupHook({
    id: "self-server:reconcile",
    // "selfhosted" excludes desktop (resolvePlatformConfig maps desktop →
    // "desktop"), so this only runs on a real server-host install.
    modes: ["selfhosted"],
    run: async () => {
      await ensureLocalServerRegistered();
    },
  });
}
