"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import Link from "next/link";

import type { SystemIssue } from "@/lib/api/issues";
import { useI18n, interpolate } from "@/components/i18n-provider";
import CopyCommand, { SELF_UPDATE_COMMAND } from "@/components/shared/CopyCommand";
import {
  ACTION_TONE,
  AlertRow,
  TEXT_TONE,
  type AlertDensity,
} from "@/components/overview/AlertPanel";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { KIND_ICON, SEVERITY_TONE, UNKNOWN_KIND_ICON } from "./issueMeta";

/**
 * One issue, rendered from the feed's own fields — no fetching, no re-derivation.
 *
 * Everything that decides how this looks arrived on the item: `severity` picks the
 * tone, `kind` picks the icon and label, and the action comes from whichever fix the
 * server attached. That's what keeps the page honest — if a row says the wrong thing,
 * the aggregator is wrong, not this file.
 *
 * Three action shapes, in the order they're checked:
 *   `infraFix`      a managed container → the existing consent-gated modal flow.
 *   `resolveWith`   an HTTP fix → its first resolution as the primary button.
 *   neither         a link to the surface that owns it.
 */
export function IssueRow({
  issue,
  density = "compact",
  busy,
  onResolve,
  onInfraFix,
}: {
  issue: SystemIssue;
  density?: AlertDensity;
  busy: boolean;
  onResolve: (issue: SystemIssue) => void;
  onInfraFix: (issue: SystemIssue) => void;
}) {
  const { t } = useI18n();
  const c = t.issues;
  const tone = SEVERITY_TONE[issue.severity] ?? "warning";
  const Icon = KIND_ICON[issue.kind] ?? UNKNOWN_KIND_ICON;
  const kindLabel = c.kinds[issue.kind] ?? issue.kind;
  const compact = density === "compact";
  const actionSize = !compact && "h-8 px-3 text-[13px]";
  const actionClass = cn(ACTION_TONE[tone], actionSize);
  const linkClass = cn(ACTION_TONE.ghost, actionSize);
  const metaClass = cn(
    "mt-0.5",
    compact ? "text-[11px] text-muted-foreground/70" : "text-xs text-muted-foreground",
  );

  // The control plane's own update is a CLI operation (the API refuses to redeploy
  // itself), so offer the command rather than a button that would 403 — the same
  // call the home Updates card makes.
  const selfUpdate = issue.kind === "update_available" && issue.scope === "platform";
  const fix = issue.resolveWith[0];

  // `expiresAt` counts DOWN (a held deploy aborts if unanswered), so `timeAgo` —
  // which reads a past instant — would render it as "just now". Minutes remaining,
  // and nothing at all once the deadline has passed.
  const expiresInMin = issue.expiresAt
    ? Math.ceil((new Date(issue.expiresAt).getTime() - Date.now()) / 60_000)
    : 0;

  /**
   * Where this happened, when it started, and when it gives up.
   *
   * The target is skipped when it merely repeats the title — a component row's title
   * IS its server — because a line reading "web-01 · web-01" spends the row's only
   * secondary line saying nothing. `since` exists on incidents alone, so a row without
   * one shows no clock rather than a fabricated one.
   */
  const meta = [
    issue.target.name === issue.title ? null : issue.target.name,
    issue.resolvedAt
      ? interpolate(c.resolvedWhen, { when: timeAgo(issue.resolvedAt, t) })
      : issue.since
        ? interpolate(c.since, { when: timeAgo(issue.since, t) })
        : null,
    expiresInMin > 0 ? interpolate(c.expiresIn, { n: String(expiresInMin) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <AlertRow
      tone={tone}
      density={density}
      icon={Icon}
      title={
        <Link href={issue.target.href} className="truncate hover:text-primary">
          {issue.title}
        </Link>
      }
      label={kindLabel}
      action={
        selfUpdate ? (
          <CopyCommand
            command={SELF_UPDATE_COMMAND}
            className={cn("shrink-0", !compact && "h-8 max-w-full")}
          />
        ) : issue.infraFix ? (
          <button type="button" onClick={() => onInfraFix(issue)} className={actionClass}>
            {issue.infraFix.action === "update" ? (
              <UiIcon name="refresh" className="size-3" />
            ) : issue.kind === "edge_absent" ? (
              <UiIcon name="download" className="size-3" />
            ) : (
              <UiIcon name="wrench" className="size-3" />
            )}
            {issue.infraFix.action === "update"
              ? c.update
              : issue.kind === "edge_absent"
                ? c.install
                : c.fix}
          </button>
        ) : fix ? (
          <button
            type="button"
            onClick={() => onResolve(issue)}
            disabled={busy}
            className={actionClass}
          >
            {busy && <UiIcon name="spinner" className="size-3 animate-spin" />}
            {fix.label}
          </button>
        ) : issue.kind === "mail_down" ? (
          // A gone mail engine has no fix from here — recreating it needs the secrets
          // only mail setup holds. Navigation, deliberately the quieter control.
          <Link href={issue.target.href} className={linkClass}>
            <UiIcon name="server" className="size-3" />
            {c.mailSetup}
          </Link>
        ) : (
          <Link href={issue.target.href} className={linkClass}>
            {c.view}
            <UiIcon name="arrow-right" className="size-3 rtl:rotate-180" />
          </Link>
        )
      }
    >
      {issue.message && (
        <p
          className={`line-clamp-2 ${compact ? "text-[12px] leading-snug" : "text-[13px] leading-relaxed"} ${
            issue.severity === "advisory" ? "text-muted-foreground" : TEXT_TONE[tone]
          }`}
          title={issue.message}
        >
          {issue.message}
        </p>
      )}
      {meta && <p className={cn("truncate", metaClass)}>{meta}</p>}
      {selfUpdate && <p className={metaClass}>{c.selfUpdateNote}</p>}
    </AlertRow>
  );
}
