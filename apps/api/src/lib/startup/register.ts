/**
 * Startup-hook registration — Self-hosted only (never SaaS).
 *
 * The single, explicit place where each feature's startup hook is registered.
 * Imported once from app.ts before `runStartupHooks()` runs, so registration
 * order is deterministic and not dependent on incidental module-load order.
 * Add new feature hooks here.
 */
import { registerTunnelAutostart } from "../ssh-tunnel-manager";
import { registerSelfAdoptReconcile } from "./self-deploy";
import { registerSelfServerReconcile } from "./self-server";

export function registerStartupHooks(): void {
  // Desktop: re-open saved port-forward tunnels marked auto-start.
  registerTunnelAutostart();
  // Self-app: reconcile the control-plane adopt deployment + route/port/cert +
  // public URL on every boot (backfills existing installs; heals port drift).
  registerSelfAdoptReconcile();
  // Server-host: register this host as an isLocal "This Server" deploy target.
  registerSelfServerReconcile();
}
