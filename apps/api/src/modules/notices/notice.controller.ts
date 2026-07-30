/**
 * Platform status notices — operator-pushed banners (partial outage, degraded
 * service, maintenance, upgrade advisories) shown across the app, mainly the
 * managed SaaS. Served in the SAME advisory-manifest shape the shared banner
 * (dashboard components/updates) already consumes, so the client renders them
 * with zero new UI. Reads are public (non-sensitive announcements); writes are
 * internal-token gated (the platform operator), never tenant-exposed.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import type { Advisory, AdvisorySeverity, AdvisoryTarget } from "@repo/core";
import { param } from "../../lib/controller-helpers";

const VALID_TARGET_TYPE = new Set<AdvisoryTarget["type"]>(["platform", "app", "project", "mail"]);

const VALID_SEVERITY = new Set<AdvisorySeverity>(["critical", "recommended", "info"]);

function toSeverity(raw: string | undefined | null): AdvisorySeverity {
  return VALID_SEVERITY.has(raw as AdvisorySeverity) ? (raw as AdvisorySeverity) : "info";
}

/**
 * Map a stored notice → the `Advisory` shape the shared banner consumes.
 * `affects: "*"` because platform notices aren't version-gated — the client
 * applies severity + per-id dismissal, not a semver range.
 */
function toAdvisory(n: {
  id: string;
  severity: string;
  title: string;
  message: string;
  actionLabel: string | null;
  actionUrl: string | null;
  targetType: string | null;
  targetId: string | null;
}): Advisory {
  const advisory: Advisory = {
    id: n.id,
    severity: toSeverity(n.severity),
    announce: false,
    affects: "*",
    title: n.title,
    message: n.message,
  };
  if (n.actionLabel && n.actionUrl) {
    advisory.action = { label: n.actionLabel, kind: "open-url", url: n.actionUrl };
  }
  if (n.targetType && VALID_TARGET_TYPE.has(n.targetType as AdvisoryTarget["type"])) {
    advisory.target = {
      type: n.targetType as AdvisoryTarget["type"],
      ...(n.targetId ? { id: n.targetId } : {}),
    };
  }
  return advisory;
}

/** GET /api/notices — active notices in the advisory-manifest shape. */
export async function list(c: Context) {
  const notices = await repos.notice.listActive();
  return c.json({ advisories: notices.map(toAdvisory) });
}

/** GET /api/notices/all — every notice incl. inactive/expired (operator). */
export async function listAll(c: Context) {
  return c.json({ notices: await repos.notice.list() });
}

/** POST /api/notices — operator pushes a notice. internalAuth-gated. */
export async function create(c: Context) {
  const body = await c.req
    .json<{
      severity?: string;
      title?: string;
      message?: string;
      actionLabel?: string;
      actionUrl?: string;
      targetType?: string;
      targetId?: string;
      startsAt?: string;
      endsAt?: string;
    }>()
    .catch(() => null);

  if (
    !body ||
    typeof body.title !== "string" ||
    !body.title.trim() ||
    typeof body.message !== "string" ||
    !body.message.trim()
  ) {
    return c.json({ error: "title and message are required", code: "INVALID_NOTICE" }, 400);
  }

  const targetType =
    body.targetType && VALID_TARGET_TYPE.has(body.targetType as AdvisoryTarget["type"])
      ? body.targetType
      : null;

  // actionUrl is rendered as an <a href> in the dashboard advisory UI — only
  // allow http(s) so a stored `javascript:`/`data:` URL can't execute on click.
  // Writes are operator/internalAuth-gated, so this is defense-in-depth.
  const actionUrl = body.actionUrl?.trim() || null;
  if (actionUrl && !/^https?:\/\//i.test(actionUrl)) {
    return c.json({ error: "actionUrl must be an http(s) URL", code: "INVALID_NOTICE" }, 400);
  }

  const notice = await repos.notice.create({
    severity: toSeverity(body.severity),
    title: body.title.trim(),
    message: body.message.trim(),
    actionLabel: body.actionLabel?.trim() || null,
    actionUrl,
    targetType,
    targetId: targetType && targetType !== "platform" ? body.targetId?.trim() || null : null,
    active: true,
    startsAt: body.startsAt ? new Date(body.startsAt) : null,
    endsAt: body.endsAt ? new Date(body.endsAt) : null,
  });
  return c.json({ notice }, 201);
}

/** DELETE /api/notices/:id — operator clears a notice (deactivate). */
export async function remove(c: Context) {
  await repos.notice.deactivate(param(c, "id"));
  return c.json({ success: true });
}
