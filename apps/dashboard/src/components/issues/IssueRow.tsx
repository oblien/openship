"use client";

import Link from "next/link";
import { ArrowRight, Download, Loader2, RefreshCw, Server, Wrench } from "lucide-react";

import type { SystemIssue } from "@/lib/api/issues";
import { useI18n, interpolate } from "@/components/i18n-provider";
import CopyCommand, { SELF_UPDATE_COMMAND } from "@/components/shared/CopyCommand";
import { ACTION_TONE, AlertRow, TEXT_TONE } from "@/components/overview/AlertPanel";
import { timeAgo } from "@/lib/time";
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
  busy,
  onResolve,
  onInfraFix,
}: {
  issue: SystemIssue;
  busy: boolean;
  onResolve: (issue: SystemIssue) => void;
  onInfraFix: (issue: SystemIssue) => void;
}) {
  const { t } = useI18n();
  const c = t.issues;
  const tone = SEVERITY_TONE[issue.severity] ?? "warning";
  const Icon = KIND_ICON[issue.kind] ?? UNKNOWN_KIND_ICON;
  const kindLabel = c.kinds[issue.kind] ?? issue.kind;

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
      icon={Icon}
      title={
        <Link href={issue.target.href} className="truncate hover:text-primary">
          {issue.title}
        </Link>
      }
      label={kindLabel}
      action={
        selfUpdate ? (
          <CopyCommand command={SELF_UPDATE_COMMAND} className="shrink-0" />
        ) : issue.infraFix ? (
          <button type="button" onClick={() => onInfraFix(issue)} className={ACTION_TONE[tone]}>
            {issue.infraFix.action === "update" ? (
              <RefreshCw className="size-3" />
            ) : issue.kind === "edge_absent" ? (
              <Download className="size-3" />
            ) : (
              <Wrench className="size-3" />
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
            className={ACTION_TONE[tone]}
          >
            {busy && <Loader2 className="size-3 animate-spin" />}
            {fix.label}
          </button>
        ) : issue.kind === "mail_down" ? (
          // A gone mail engine has no fix from here — recreating it needs the secrets
          // only mail setup holds. Navigation, deliberately the quieter control.
          <Link href={issue.target.href} className={ACTION_TONE.ghost}>
            <Server className="size-3" />
            {c.mailSetup}
          </Link>
        ) : (
          <Link href={issue.target.href} className={ACTION_TONE.ghost}>
            {c.view}
            <ArrowRight className="size-3 rtl:rotate-180" />
          </Link>
        )
      }
    >
      {issue.message && (
        <p
          className={`line-clamp-2 text-[12px] leading-snug ${
            issue.severity === "advisory" ? "text-muted-foreground" : TEXT_TONE[tone]
          }`}
          title={issue.message}
        >
          {issue.message}
        </p>
      )}
      {meta && <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{meta}</p>}
      {selfUpdate && (
        <p className="mt-0.5 text-[11px] text-muted-foreground/70">{c.selfUpdateNote}</p>
      )}
    </AlertRow>
  );
}
