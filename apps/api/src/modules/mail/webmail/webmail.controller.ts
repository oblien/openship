/**
 * Webmail HTTP endpoints.
 *
 *   GET  /mail/webmail/targets?serverId=…   - host picker options
 *   POST /mail/webmail/deploy-project       - create project + deployment
 *
 * Self-hosted only (the parent /mail mount applies localOnly + auth).
 */

import type { Context } from "hono";
import { env } from "../../../config";
import { getRequestContext } from "../../../lib/request-context";
import { listWebmailTargets } from "./webmail.service";
import {
  startWebmailDeploy,
  startExternalWebmailDeploy,
} from "./webmail-project.service";

const HOSTNAME_RE = /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/;
const portOk = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

// ─── GET /mail/webmail/targets ───────────────────────────────────────────────

export async function getTargetsHandler(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const ctx = getRequestContext(c);
  const mailServerId = c.req.query("serverId");
  if (!mailServerId) {
    return c.json({ error: "serverId is required" }, 400);
  }
  // org-scoped: only return targets within the caller's org (the route
  // tag proves membership but not that mailServerId is theirs).
  const options = await listWebmailTargets(mailServerId, ctx.organizationId);
  return c.json({ options });
}

// ─── POST /mail/webmail/deploy-project ───────────────────────────────────────

/**
 * Body:
 *   {
 *     mailServerId: string,
 *     hostname: string,
 *     internalPort?: number,
 *     target:
 *       | { kind: "self", serverId: string }   // self-hosted on an openship server
 *       | { kind: "cloud" }                    // managed by Opshcloud
 *   }
 *
 * Creates (or reuses) the webmail project + a queued deployment + a build
 * session, then kicks off the engine in the background. Returns the IDs so
 * the dashboard can redirect to /build/[deploymentId] and subscribe to the
 * standard SSE endpoint.
 *
 * Build strategy is fixed at "server" - webmail is always built at the
 * deploy target (self-hosted server or cloud builder). See
 * webmail-project.service.ts for the full rationale.
 */
export async function startDeployAsProjectHandler(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const ctx = getRequestContext(c);
  const userId = ctx.userId;
  const organizationId = ctx.organizationId;
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const mailServerId = body.mailServerId as string | undefined;
  const hostname = (body.hostname as string | undefined)?.trim().toLowerCase();
  const internalPort =
    typeof body.internalPort === "number" ? body.internalPort : undefined;
  const targetBody = body.target as
    | { kind?: string; serverId?: string }
    | undefined;

  if (!mailServerId) return c.json({ error: "mailServerId is required" }, 400);
  if (!hostname || !HOSTNAME_RE.test(hostname))
    return c.json({ error: "Invalid domain" }, 400);

  let target: { kind: "self"; serverId: string } | { kind: "cloud" };
  if (targetBody?.kind === "cloud") {
    target = { kind: "cloud" };
  } else if (targetBody?.kind === "self" && targetBody.serverId) {
    target = { kind: "self", serverId: targetBody.serverId };
  } else {
    return c.json(
      {
        error:
          "target is required: { kind: \"self\", serverId } or { kind: \"cloud\" }",
      },
      400,
    );
  }

  try {
    const { deploymentId, projectId } = await startWebmailDeploy(ctx, {
      mailServerId,
      hostname,
      internalPort,
      target,
    });
    return c.json({ deploymentId, projectId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start deploy";
    return c.json({ error: message }, 500);
  }
}

// ─── POST /mail/webmail/deploy-external ──────────────────────────────────────

/**
 * Deploy the Zero webmail UI pointed at an EXTERNAL IMAP/SMTP backend — the
 * "Connect existing" provider path (Amazon SES for send + a read IMAP host, or
 * a fully custom backend). No mail server / iRedMail install required.
 *
 * Body:
 *   {
 *     hostname: string,                       // public host for the webmail UI
 *     backend: {
 *       provider: "ses" | "custom",
 *       imapHost, imapPort, smtpHost, smtpPort
 *     },
 *     target: { deployTarget: "server"|"cloud"|"local", serverId? },
 *     internalPort?: number
 *   }
 */
export async function startExternalDeployAsProjectHandler(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

  const hostname = (body.hostname as string | undefined)?.trim().toLowerCase();
  if (!hostname || !HOSTNAME_RE.test(hostname))
    return c.json({ error: "Invalid domain" }, 400);

  const backendBody = body.backend as Record<string, unknown> | undefined;
  const provider = backendBody?.provider;
  const imapHost = (backendBody?.imapHost as string | undefined)?.trim().toLowerCase();
  const smtpHost = (backendBody?.smtpHost as string | undefined)?.trim().toLowerCase();
  const imapPort = Number(backendBody?.imapPort);
  const smtpPort = Number(backendBody?.smtpPort);
  if (provider !== "ses" && provider !== "custom")
    return c.json({ error: "backend.provider must be \"ses\" or \"custom\"" }, 400);
  if (!imapHost || !HOSTNAME_RE.test(imapHost))
    return c.json({ error: "Invalid IMAP host" }, 400);
  if (!smtpHost || !HOSTNAME_RE.test(smtpHost))
    return c.json({ error: "Invalid SMTP host" }, 400);
  if (!portOk(imapPort)) return c.json({ error: "Invalid IMAP port" }, 400);
  if (!portOk(smtpPort)) return c.json({ error: "Invalid SMTP port" }, 400);

  const targetBody = body.target as { deployTarget?: string; serverId?: string } | undefined;
  const dt = targetBody?.deployTarget;
  if (dt !== "server" && dt !== "cloud" && dt !== "local")
    return c.json({ error: "target.deployTarget must be \"server\", \"cloud\", or \"local\"" }, 400);
  if (dt === "server" && !targetBody?.serverId)
    return c.json({ error: "target.serverId is required for a server target" }, 400);

  let internalPort: number | undefined;
  if (body.internalPort !== undefined && body.internalPort !== null) {
    const p = Number(body.internalPort);
    if (!portOk(p)) return c.json({ error: "Invalid internal port" }, 400);
    internalPort = p;
  }

  try {
    const { deploymentId, projectId } = await startExternalWebmailDeploy(ctx, {
      hostname,
      backend: { provider, imapHost, imapPort, smtpHost, smtpPort },
      target: { deployTarget: dt, serverId: targetBody?.serverId },
      internalPort,
    });
    return c.json({ deploymentId, projectId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start deploy";
    return c.json({ error: message }, 500);
  }
}
