/**
 * Cloud SaaS controller — runs only in CLOUD_MODE.
 *
 * All imports are top-level (no per-request dynamic imports on hot paths).
 * SaaS owns the Oblien master credentials, auth session management, and
 * handoff code generation.
 *
 *   POST /api/cloud/token           — mint namespace-scoped Oblien tokens
 *   POST /api/cloud/analytics       — proxy Oblien analytics (master client)
 *   POST /api/cloud/edge-proxy      — sync Oblien edge proxy for managed domains
 *   POST /api/cloud/preflight       — cloud deployment preflight check
 *   GET  /api/cloud/desktop-handoff — OAuth → one-time code → redirect to desktop
 *   GET  /api/cloud/connect-handoff — OAuth → one-time code → redirect to self-hosted
 *   POST /api/cloud/exchange-code   — exchange code for user + session (no auth)
 */

import type { Context } from "hono";
import { SYSTEM } from "@repo/core";
import { getUserId } from "../../lib/controller-helpers";
import { auth } from "../../lib/auth";
import { issueNamespaceToken, getOblienClient } from "../../lib/openship-cloud";
import { generateHandoffCode, exchangeHandoffCode } from "../../lib/cloud-auth-proxy";
import { runCloudPreflight } from "../../lib/cloud-preflight";

// ─── Cloud analytics proxy (master client) ───────────────────────────────────

/**
 * POST /api/cloud/analytics  { operation, domain, params }
 *
 * Local/desktop instances call this to get Oblien analytics.
 * Edge proxies + analytics are account-level — namespace tokens can't access them.
 * The SaaS uses the master Oblien client on behalf of the caller.
 */
export async function analyticsProxy(c: Context) {
  const { operation, domain, params } = await c.req.json<{
    operation: "timeseries" | "requests" | "streamToken";
    domain: string;
    params?: Record<string, unknown>;
  }>();

  if (!operation || !domain) {
    return c.json({ error: "operation and domain are required" }, 400);
  }

  const client = getOblienClient();

  try {
    switch (operation) {
      case "timeseries": {
        const result = await client.analytics.timeseries(domain, params as any);
        return c.json(result);
      }
      case "requests": {
        const result = await client.analytics.requests(domain, params as any);
        return c.json(result);
      }
      case "streamToken": {
        const result = await client.analytics.streamToken(domain);
        return c.json(result);
      }
      default:
        return c.json({ error: "Unknown operation" }, 400);
    }
  } catch (err: unknown) {
    const status = typeof err === "object" && err !== null && "status" in err
      ? (err as { status: number }).status
      : 500;
    const message = err instanceof Error ? err.message : "Analytics request failed";
    c.status(status as 400 | 404 | 500);
    return c.json({ error: message });
  }
}

// ─── Namespace token minting ─────────────────────────────────────────────────

export async function getToken(c: Context) {
  const userId = getUserId(c);
  const result = await issueNamespaceToken(userId);
  return c.json({ data: result });
}

export async function preflight(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<{ slug?: string; customDomain?: string }>();
  const result = await runCloudPreflight(userId, {
    slug: body.slug,
    customDomain: body.customDomain,
  });
  return c.json({ data: result });
}

export async function account(c: Context) {
  const user = c.get("user") as
    | { name?: string | null; email?: string | null; image?: string | null }
    | undefined;

  if (!user?.email) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({
    user: {
      name: user.name ?? user.email,
      email: user.email,
      image: user.image ?? null,
    },
  });
}

// ─── Desktop OAuth handoff ───────────────────────────────────────────────────

/**
 * GET /api/cloud/desktop-handoff?redirect=<url>&state=<state>&code_challenge=<challenge>
 *
 * Security:
 *   - redirect MUST be localhost (desktop callback) — no open redirect
 *   - state is passed through unchanged for CSRF protection
 *   - code_challenge (PKCE S256) is bound to the one-time code
 */
export async function desktopHandoff(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "No active session" }, 401);
  }

  const redirect = c.req.query("redirect");
  if (!redirect) {
    return c.json({ error: "Missing redirect parameter" }, 400);
  }

  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return c.json({ error: "Invalid redirect URL" }, 400);
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return c.json({ error: "Redirect must target localhost" }, 400);
  }
  const port = parseInt(url.port || "80", 10);
  if (port < 1024 || port > 65535) {
    return c.json({ error: "Redirect port must be ≥ 1024" }, 400);
  }

  const state = c.req.query("state");
  const codeChallenge = c.req.query("code_challenge");

  const code = await generateHandoffCode(
    {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
    },
    session.session.token,
    codeChallenge || undefined,
  );

  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

// ─── Self-hosted connect handoff ─────────────────────────────────────────────

/**
 * GET /api/cloud/connect-handoff?redirect=<url>
 *
 * Security:
 *   - redirect MUST be HTTPS (no downgrade to HTTP), except localhost
 *   - Codes are single-use with 60s TTL
 */
export async function connectHandoff(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "No active session" }, 401);
  }

  const redirect = c.req.query("redirect");
  if (!redirect) {
    return c.json({ error: "Missing redirect parameter" }, 400);
  }

  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return c.json({ error: "Invalid redirect URL" }, 400);
  }

  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocalhost && url.protocol !== "https:") {
    return c.json({ error: "Redirect must use HTTPS" }, 400);
  }
  if (isLocalhost) {
    const port = parseInt(url.port || "80", 10);
    if (port < 1024 || port > 65535) {
      return c.json({ error: "Redirect port must be ≥ 1024" }, 400);
    }
  }

  const code = await generateHandoffCode(
    {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
    },
    session.session.token,
  );

  url.searchParams.set("code", code);
  return c.redirect(url.toString());
}

// ─── Code exchange (no auth — code is the credential) ────────────────────────

export async function exchangeCode(c: Context) {
  const body = await c.req.json<{ code: string; code_verifier?: string }>();
  if (!body.code) {
    return c.json({ error: "Code required" }, 400);
  }

  const result = exchangeHandoffCode(body.code, body.code_verifier);
  if (!result) {
    return c.json({ error: "Invalid or expired code" }, 401);
  }

  return c.json({ data: result });
}

// ─── Managed edge proxy sync ─────────────────────────────────────────────────

/**
 * POST /api/cloud/edge-proxy  { slug: string, target: string }
 *
 * Self-hosted/desktop instances send just the project slug + target IP.
 * SaaS uses the managed base domain (opsh.io) and creates slug.opsh.io.
 */
export async function syncEdgeProxy(c: Context) {
  const body = await c.req.json<{ slug?: string; target?: string }>();
  if (!body.slug || !body.target) {
    return c.json({ error: "slug and target are required" }, 400);
  }

  const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug) {
    return c.json({ error: "Invalid slug" }, 400);
  }

  const baseDomain = SYSTEM.DOMAINS.CLOUD_DOMAIN;
  const hostname = `${slug}.${baseDomain}`;
  const target = body.target.startsWith("http://") || body.target.startsWith("https://")
    ? body.target
    : `http://${body.target}`;

  try {
    const client = getOblienClient();
    const { proxies } = await client.edgeProxy.list();
    const existing = proxies.find(
      (p) => p.slug === slug,
    );

    if (!existing) {
      await client.edgeProxy.create({ name: hostname, slug, domain: baseDomain, target });
    } else {
      if (existing.name !== hostname || existing.slug !== slug || existing.target !== target) {
        await client.edgeProxy.update(existing.id, { name: hostname, slug, target });
      }
      if (existing.status === "disabled") {
        await client.edgeProxy.enable(existing.id);
      }
    }

    return c.json({ ok: true, hostname });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to sync edge proxy";
    const status = typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
    const code = typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
    const details = typeof err === "object" && err !== null && "details" in err
      ? (err as { details?: unknown }).details
      : undefined;

    console.error("[CLOUD] Edge proxy sync failed", { slug, baseDomain, target, status, code, details, message });
    c.status(status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500);
    return c.json({ error: message, code, details });
  }
}
