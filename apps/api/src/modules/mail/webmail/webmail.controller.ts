/**
 * Webmail HTTP endpoints.
 *
 *   GET  /mail/webmail/targets           - host picker options
 *   POST /mail/webmail/deploy-project    - install/redeploy webmail for a mail server
 *   POST /mail/webmail/deploy-external   - same app, an external IMAP/SMTP backend
 *
 * Thin: validate the request shape, then hand off to the install service, which
 * drives the GENERIC app installer. Self-hosted only (the parent /mail mount
 * applies localOnly + auth).
 */

import type { Context } from "hono";
import { AppError, isRelayProviderId, RELAY_PROVIDER_IDS } from "@repo/core";
import { env } from "../../../config";
import { getRequestContext } from "../../../lib/request-context";
import { listWebmailTargets } from "./webmail.service";
import {
  startWebmailDeploy,
  startExternalWebmailDeploy,
} from "./webmail-install.service";

const HOSTNAME_RE = /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/;
const portOk = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

/**
 * The install service refuses in ways the operator can act on — a hostname
 * pinned to the mail box (400), a catalog too old to hold the app (409), a
 * pre-catalog webmail that has to be replaced rather than redeployed (409).
 * Flattening those to 500 turned every one into "something went wrong", so the
 * status is carried through and only genuinely unexpected failures read as a
 * server error. The `code` goes with it: `LEGACY_WEBMAIL` is the one refusal a
 * client can resolve on its own, by asking and retrying with `replaceLegacy`.
 */
function deployError(c: Context, err: unknown) {
  if (err instanceof AppError) {
    return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
  }
  const message = err instanceof Error ? err.message : "Failed to start deploy";
  return c.json({ error: message }, 500);
}

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
 *     target:
 *       | { kind: "self", serverId: string }   // self-hosted on an openship server
 *       | { kind: "cloud" }                    // managed by Opshcloud
 *     replaceLegacy?: boolean                  // consent to replace a pre-catalog webmail
 *   }
 *
 * Installs (or redeploys) the webmail app for this mail server and returns the
 * IDs so the dashboard can redirect to /build/[deploymentId] and subscribe to
 * the standard SSE endpoint.
 *
 * A webmail deployed by an older Openship can't be redeployed, only replaced, so
 * it answers 409 `LEGACY_WEBMAIL` until `replaceLegacy` says yes — never on the
 * first call, which is what keeps a destructive upgrade out of a plain retry.
 *
 * No port to choose: the webmail image serves on the port its catalog entry
 * declares, and the host port is assigned by the runtime like any other app.
 */
export async function startDeployAsProjectHandler(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const mailServerId = body.mailServerId as string | undefined;
  const hostname = (body.hostname as string | undefined)?.trim().toLowerCase();
  const targetBody = body.target as { kind?: string; serverId?: string } | undefined;

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
        error: 'target is required: { kind: "self", serverId } or { kind: "cloud" }',
      },
      400,
    );
  }

  try {
    const { deploymentId, projectId } = await startWebmailDeploy(ctx, {
      mailServerId,
      hostname,
      target,
      replaceLegacy: body.replaceLegacy === true,
    });
    return c.json({ deploymentId, projectId });
  } catch (err) {
    return deployError(c, err);
  }
}

// ─── POST /mail/webmail/deploy-external ──────────────────────────────────────

/**
 * Deploy the webmail app pointed at an EXTERNAL IMAP/SMTP backend — the
 * "Connect existing" path (a provider for send + a read IMAP host, or a fully
 * custom backend). No mail server install required.
 *
 * Body:
 *   {
 *     hostname: string,                       // public host for the webmail UI
 *     backend: {
 *       provider: RelayProviderId,            // label only — hosts are used verbatim
 *       imapHost, imapPort, smtpHost, smtpPort
 *     },
 *     target: { deployTarget: "server"|"cloud", serverId? }
 *   }
 */
export async function startExternalDeployAsProjectHandler(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);

  const hostname = (body.hostname as string | undefined)?.trim().toLowerCase();
  if (!hostname || !HOSTNAME_RE.test(hostname))
    return c.json({ error: "Invalid domain" }, 400);

  const backendBody = body.backend as Record<string, unknown> | undefined;
  const provider = backendBody?.provider;
  const imapHost = (backendBody?.imapHost as string | undefined)?.trim().toLowerCase();
  const smtpHost = (backendBody?.smtpHost as string | undefined)?.trim().toLowerCase();
  const imapPort = Number(backendBody?.imapPort);
  const smtpPort = Number(backendBody?.smtpPort);
  // Validated but not forwarded: the provider is the label the operator picked
  // in the wizard, and the hosts below are the entire configuration.
  if (!isRelayProviderId(provider))
    return c.json(
      { error: `backend.provider must be one of: ${RELAY_PROVIDER_IDS.join(", ")}` },
      400,
    );
  if (!imapHost || !HOSTNAME_RE.test(imapHost))
    return c.json({ error: "Invalid IMAP host" }, 400);
  if (!smtpHost || !HOSTNAME_RE.test(smtpHost))
    return c.json({ error: "Invalid SMTP host" }, 400);
  if (!portOk(imapPort)) return c.json({ error: "Invalid IMAP port" }, 400);
  if (!portOk(smtpPort)) return c.json({ error: "Invalid SMTP port" }, 400);

  // A destination is a binding: a server row, or a cloud workspace. "local" is not
  // accepted — it's derived from the absence of a binding, and this box appears in
  // the server list on a server-host, so naming it here only lost that row's real
  // address (a webmail reachable at `localhost` and nowhere else).
  const targetBody = body.target as { deployTarget?: string; serverId?: string } | undefined;
  const dt = targetBody?.deployTarget;
  if (dt !== "server" && dt !== "cloud")
    return c.json({ error: 'target.deployTarget must be "server" or "cloud"' }, 400);
  if (dt === "server" && !targetBody?.serverId)
    return c.json({ error: "target.serverId is required for a server target" }, 400);

  try {
    const { deploymentId, projectId } = await startExternalWebmailDeploy(ctx, {
      hostname,
      backend: { imapHost, imapPort, smtpHost, smtpPort },
      target: { deployTarget: dt, serverId: targetBody?.serverId },
    });
    return c.json({ deploymentId, projectId });
  } catch (err) {
    return deployError(c, err);
  }
}
