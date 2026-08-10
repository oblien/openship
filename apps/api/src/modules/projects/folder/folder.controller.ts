import type { Context } from "hono";
import { safeErrorMessage } from "@repo/core";
import { getRequestContext } from "../../../lib/request-context";
import { requestApiPublicUrl } from "../../../lib/public-url";
import { projectInfoToScanResponse } from "../../deployments/prepare.service";
import { createFolderSession, acceptRelayUpload, scanFolderSession } from "./folder.service";
import { getFolderSession } from "./session-store";

/**
 * POST /projects/folder/session
 * Open a folder-upload session. Returns the upload target: an Oblien
 * workspace-scoped token (SaaS, direct upload) or a relay upload path +
 * single-use ticket (self-hosted).
 */
export async function createSession(c: Context) {
  const { organizationId, userId } = getRequestContext(c);
  const body = await c.req
    .json<{ stack?: string; packageManager?: string; name?: string }>()
    .catch(() => ({}) as { stack?: string; packageManager?: string; name?: string });

  try {
    const result = await createFolderSession({
      orgId: organizationId,
      userId,
      stack: body.stack,
      packageManager: body.packageManager,
      name: body.name,
      apiBaseUrl: requestApiPublicUrl(c.req.raw),
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 502);
  }
}

/**
 * POST /projects/folder/upload/:sessionId  (self-hosted only)
 * Streamed tar.gz body → staging dir. Ticket-authorized. Binary body, so this
 * route is excluded from MCP tool generation (see mcp-tools DENY list).
 */
export async function uploadRelay(c: Context) {
  const { organizationId } = getRequestContext(c);
  const sessionId = c.req.param("sessionId");
  const session = sessionId ? getFolderSession(sessionId) : undefined;
  if (!session || session.orgId !== organizationId) {
    return c.json({ error: "Upload session not found" }, 404);
  }
  if (session.mode !== "api-relay") {
    return c.json({ error: "Session does not accept relay uploads" }, 400);
  }

  const ticket = c.req.header("x-upload-ticket") ?? c.req.query("ticket");
  if (!ticket || ticket !== session.uploadTicket) {
    return c.json({ error: "Invalid upload ticket" }, 403);
  }

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Empty upload" }, 400);

  try {
    await acceptRelayUpload(session, body);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
}

/**
 * POST /projects/folder/scan/:sessionId
 * Authoritative framework detection on the uploaded source. Same response
 * shape as scanLocal so the deploy wizard consumes it unchanged.
 */
export async function scanSession(c: Context) {
  const { organizationId } = getRequestContext(c);
  const sessionId = c.req.param("sessionId");
  const session = sessionId ? getFolderSession(sessionId) : undefined;
  if (!session || session.orgId !== organizationId) {
    return c.json({ error: "Upload session not found" }, 404);
  }

  try {
    const result = await scanFolderSession(session);
    return c.json({ success: true, sessionId, ...projectInfoToScanResponse(result) });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
}

/**
 * GET /projects/folder/scan/:sessionId/env-reveal
 * #336: the scan response masks compose env, so the wizard's "show values"
 * toggle fetches the REAL values here. Backed by `session.services`, which the
 * scan captured PRE-mask. Write-gated at the route (project:write) so a
 * read-only caller can't reveal. Returns real env keyed by service name.
 */
export async function revealSessionEnv(c: Context) {
  const { organizationId } = getRequestContext(c);
  const sessionId = c.req.param("sessionId");
  const session = sessionId ? getFolderSession(sessionId) : undefined;
  if (!session || session.orgId !== organizationId) {
    return c.json({ error: "Upload session not found" }, 404);
  }
  const environments: Record<string, Record<string, string>> = {};
  for (const s of session.services ?? []) {
    if (s.name) environments[s.name] = s.environment ?? {};
  }
  return c.json({ success: true, environments });
}
