/** Retained notice presentation and persistence, independent of HTTP. */
import { repos } from "@repo/db";
import { AppError, type AdvisorySeverity, type AdvisoryTarget } from "@repo/core";
import type { Static } from "@sinclair/typebox";
import type { CreateNoticeInput, NoticeAdvisorySchema } from "@repo/contracts";

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
}): Static<typeof NoticeAdvisorySchema> {
  const advisory: Static<typeof NoticeAdvisorySchema> = {
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

export async function list() {
  const notices = await repos.notice.listActive();
  return { advisories: notices.map(toAdvisory) };
}

export async function listAll() { return repos.notice.list(); }

function noticeDate(value: string | undefined, field: string): Date | null {
  if (!value) return null;
  // Explicit UTC/offset avoids a worker and HTTP process interpreting local times differently.
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))
    throw new AppError(`${field} must be an ISO date or timestamp with a timezone`, 400, "INVALID_NOTICE");
  const date = new Date(value);
  const day = value.slice(0, 10);
  if (!Number.isFinite(date.getTime()) || new Date(day).toISOString().slice(0, 10) !== day)
    throw new AppError(`${field} must be a valid date`, 400, "INVALID_NOTICE");
  return date;
}

export async function create(body: CreateNoticeInput) {
  if (!body.title.trim() || !body.message.trim())
    throw new AppError("title and message are required", 400, "INVALID_NOTICE");
  const targetType = body.targetType && VALID_TARGET_TYPE.has(body.targetType as AdvisoryTarget["type"])
    ? body.targetType : null;
  const actionUrl = body.actionUrl?.trim() || null;
  if (actionUrl) {
    let valid = false;
    try { const url = new URL(actionUrl); valid = /^https?:\/\//i.test(actionUrl) && ["http:", "https:"].includes(url.protocol); } catch { /* rejected below */ }
    if (!valid) throw new AppError("actionUrl must be an http(s) URL", 400, "INVALID_NOTICE");
  }
  const startsAt = noticeDate(body.startsAt, "startsAt");
  const endsAt = noticeDate(body.endsAt, "endsAt");
  if (startsAt && endsAt && endsAt < startsAt)
    throw new AppError("endsAt must not precede startsAt", 400, "INVALID_NOTICE");
  return repos.notice.create({
    severity: toSeverity(body.severity), title: body.title.trim(), message: body.message.trim(),
    actionLabel: body.actionLabel?.trim() || null, actionUrl, targetType,
    targetId: targetType && targetType !== "platform" ? body.targetId?.trim() || null : null,
    active: true, startsAt, endsAt,
  });
}

/** Retain deactivation rather than deleting history, including idempotent repeats. */
export async function remove(id: string) {
  await repos.notice.deactivate(id);
  return { success: true as const };
}
