/**
 * Self-hosted desktop issuer.
 *
 * These three routes are the part of the cloud handoff a self-hosted
 * control plane must answer so a desktop can link it. They do not turn
 * the process into CLOUD_MODE: no billing, no Oblien, no edge proxy.
 *
 *   GET  /api/cloud/desktop-handoff
 *   POST /api/cloud/exchange-code
 *   GET  /api/cloud/account
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { Context } from "hono";
import { repos } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { requestPublicOrigin } from "@repo/platform/engine/lib/public-url";
import {
  buildAuthHandoff,
  exchangeHandoffCode,
  validateDesktopRedirect,
} from "../../lib/cloud-auth-proxy";

function issuerDashboardOrigin(c: Context): string | null {
  try {
    const url = new URL(requestPublicOrigin(c.req.raw));
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * GET /api/cloud/desktop-handoff
 *
 * Same contract as the cloud handler. The login bounce stays on THIS
 * instance. It must not fall back to app.openship.io.
 */
export async function desktopHandoff(c: Context) {
  const codeChallenge = c.req.query("code_challenge");
  if (!codeChallenge || !/^[A-Za-z0-9_-]{40,128}$/.test(codeChallenge)) {
    return c.json(
      { error: "code_challenge query parameter is required", code: "MISSING_CODE_CHALLENGE" },
      400,
    );
  }
  const validation = validateDesktopRedirect(c.req.query("redirect"));
  if (!validation.ok) return c.json({ error: validation.error }, validation.status);
  const dashboardOrigin = issuerDashboardOrigin(c);
  if (!dashboardOrigin) return c.json({ error: "Dashboard origin is not available" }, 400);

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const token = session?.session?.token;
  const handoffSession =
    session?.user?.email && token
      ? {
          user: {
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
            emailVerified: session.user.emailVerified,
            image: session.user.image ?? null,
          },
          session: { token },
        }
      : null;
  const result = await buildAuthHandoff({
    session: handoffSession,
    redirect: validation.url,
    state: c.req.query("state"),
    codeChallenge,
    dashboardOrigin,
    loginFlow: "desktop-cloud",
  });
  return c.redirect(result.url);
}

/** POST /api/cloud/exchange-code — the one-time code is the credential. */
export async function exchangeCode(c: Context) {
  const body = await c.req.json<{ code?: string; code_verifier?: string }>().catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "api/modules/cloud/cloud-issuer.controller");
    return null;
  });
  if (!body?.code) return c.json({ error: "Code required" }, 400);
  const result = await exchangeHandoffCode(body.code, body.code_verifier);
  if (!result) return c.json({ error: "Invalid or expired code" }, 401);
  return c.json({ data: result });
}

/**
 * GET /api/cloud/account
 *
 * Bearer is the desktop's linked session. `id` and `organizationId` are
 * both required: the desktop refuses to store a profile-only account.
 * Organization is the session's active org when the user still belongs
 * to it, otherwise the oldest membership.
 */
export async function account(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const user = session?.user;
  if (!session || !user?.id || !user.email) return c.json({ error: "Unauthorized" }, 401);

  const memberships = await repos.member.listByUser(user.id);
  const active = session.session.activeOrganizationId;
  const chosen = memberships.find((row) => row.organizationId === active) ?? memberships[0];
  if (!chosen) return c.json({ error: "Unauthorized" }, 401);

  return c.json({
    user: {
      id: user.id,
      organizationId: chosen.organizationId,
      name: user.name ?? user.email,
      email: user.email,
      image: user.image ?? null,
    },
  });
}
