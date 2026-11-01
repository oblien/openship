/**
 * Startup-hook registration — Self-hosted only (never SaaS).
 *
 * The single, explicit place where each feature's startup hook is registered.
 * Imported once from app.ts before `runStartupHooks()` runs, so registration
 * order is deterministic and not dependent on incidental module-load order.
 * Add new feature hooks here.
 */
import { registerTunnelAutostart } from "@repo/platform/engine/lib/ssh-tunnel-manager";
import { registerSelfAdoptReconcile } from "./self-deploy";
import { registerSelfServerReconcile } from "@repo/platform/engine/lib/startup/self-server";
import { registerInfraReconcile } from "./infra-reconcile";
import { registerAppServiceRowReconcile } from "@repo/platform/engine/modules/services/service.service";
import { registerCustomCommandRestoreBackfill } from "@repo/platform/engine/modules/backups/restore-command-backfill";
import { registerCredentialBackfill } from "./credential-backfill";
import { registerNetworkSetupRecovery } from "@repo/platform/engine/lib/startup/network-setups";

export function registerStartupHooks(): void {
  // Persist stopped preparation/apply/check runs before serving saved progress.
  registerNetworkSetupRecovery();
  // Desktop: re-open saved port-forward tunnels marked auto-start.
  registerTunnelAutostart();
  // Self-app: reconcile the control-plane adopt deployment + route/port/cert +
  // public URL on every boot (backfills existing installs; heals port drift).
  registerSelfAdoptReconcile();
  // Server-host: register this host as an isLocal "This Server" deploy target.
  registerSelfServerReconcile();
  // Infra: on a control-plane version bump, scan remote edge/mail containers for
  // drift (and auto-apply when autoUpdateInfra is on). Fires once per version.
  registerInfraReconcile();
  // #231: backfill an app-framework project's app as a service row when it has
  // sidecars but no app row, so its deploy stops dropping the app. #589: and the
  // reverse — remove a slug-named app row from a project with no build recipe,
  // which no deploy could ever bring up.
  registerAppServiceRowReconcile();
  // D5: re-attach `restoreCommand` to custom_command backup runs captured while
  // the orchestrator was dropping it — every mail-server backup on the instance.
  registerCustomCommandRestoreBackfill();
  // Move `dns_credential` rows into the generic credential store. Code, not SQL: the two
  // encryption envelopes wrap different things and only the app holds the key — so a
  // `DROP TABLE` in this release would have destroyed every token before it was copied.
  registerCredentialBackfill();
}
