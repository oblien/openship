import type { Context, Next } from "hono";
import { db, schema } from "@repo/db";
import { env, runtimeTargetId } from "@repo/platform/engine/config/env";
import { localBootstrapEnabled, withLocalSignup } from "@repo/platform/engine/lib/local-bootstrap";
import { isLoopbackRequest } from "./loopback-peer";

export function isLocalBootstrapRequest(c: Context): boolean {
  return localBootstrapEnabled() && isLoopbackRequest(c);
}

export async function firstSignupGuard(c: Context, next: Next) {
  if (env.CLOUD_MODE || runtimeTargetId === "cloud-saas") return next();
  if (isLocalBootstrapRequest(c)) {
    const [anyUser] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
    if (!anyUser) return withLocalSignup(next);
  }
  return c.json({
    error: "Public sign-up is disabled on this instance. Use the local setup or your invitation link to join.",
    code: "SIGNUP_DISABLED",
  }, 403);
}
