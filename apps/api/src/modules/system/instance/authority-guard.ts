import type { MiddlewareHandler } from "hono";
import { env } from "@repo/platform/engine/config/env";
import {
  controllerState,
  controllerEnvironmentReady,
  trackControllerRequest,
} from "./controller-state";

/** Fail closed. The migration lock is not an ownership fence: its timeout and
 * legacy fail-open behavior are appropriate for neither snapshots nor cutover. */
export const instanceAuthorityGuard: MiddlewareHandler = async (c, next) => {
  if (
    env.CLOUD_MODE ||
    // UI diagnostics belong to this instance even while Desktop is relaying
    // operations elsewhere. Never forward a queued report to a new account.
    c.req.path === "/api/diagnostics/client-errors" ||
    c.req.path.startsWith("/api/system/instance/") ||
    c.req.path === "/api/system/instance" ||
    c.req.path === "/api/health"
  )
    return next();
  // Register BEFORE the asynchronous role read, so freeze cannot miss a request
  // that observed active just before the durable fence was committed.
  const finish = trackControllerRequest();
  try {
    const state = await controllerState();
    if (state.role !== "active" || !controllerEnvironmentReady(state)) {
      if (
        ["retired", "connected"].includes(state.role) &&
        env.DEPLOY_MODE === "desktop" &&
        state.connection
      ) {
        const { relayInstanceRequest } = await import("./desktop-relay");
        return relayInstanceRequest(c, state);
      }
      c.header("Retry-After", "5");
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          code: "INSTANCE_CONTROLLER_INACTIVE",
          error:
            state.role === "retired"
              ? "This instance has moved. Open the active instance to continue."
              : "Your instance is moving. Existing apps keep running; changes resume after the handoff.",
          role: state.role,
        },
        503,
      );
    }
    await next();
  } finally {
    finish();
  }
};
