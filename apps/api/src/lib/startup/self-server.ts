/**
 * Self-server reconcile — Self-hosted (server-host / "VPS") only.
 *
 * When OpenShip runs ON a server (docker/bare self-host — the `modes` gate below
 * excludes desktop), the host is itself a deployable target. This registers it
 * ONCE as an `isLocal` "This Server" row so it shows up in /servers and becomes
 * a first-class deploy target. Deploys to it resolve to the LOCAL host executor
 * (createHostExecutor), not SSH — see `deployment-runtime.resolveTargetPlatform`.
 *
 * Idempotent: no-op if the row already exists, or if no founding admin exists
 * yet (fresh box pre-onboarding — the hook runs every boot and creates it once
 * an admin is present).
 */
import { env } from "../../config/env";
import { repos } from "@repo/db";
import { foundingAdminId } from "../../modules/system/self-app.controller";
import { registerStartupHook } from "./index";

export function registerSelfServerReconcile(): void {
  registerStartupHook({
    id: "self-server:reconcile",
    // "selfhosted" excludes desktop (resolvePlatformConfig maps desktop →
    // "desktop"), so this only runs on a real server-host install.
    modes: ["selfhosted"],
    run: async () => {
      const adminId = await foundingAdminId();
      if (!adminId) return; // no admin/org yet — retry next boot
      const organizationId = `org_${adminId}`;

      if (await repos.server.findLocal(organizationId)) return; // already registered

      // ssh* fields are display-only for an isLocal row (never dialed). Prefer a
      // real address so the servers list reads truthfully.
      const displayHost = env.SERVER_IP || env.HOST_DOMAIN || "127.0.0.1";

      await repos.server.create({
        organizationId,
        name: "This Server",
        sshHost: displayHost,
        isLocal: true,
      });
      console.log(`[self-server] registered this host as a deploy target (${displayHost})`);
    },
  });
}
