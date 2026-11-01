"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import Link from "next/link";

import { isMonitoringConnectionIssue, issueUpdateInProgress, type SystemIssue } from "@/lib/api/issues";
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
import { localizeDiagnosisMessage } from "@/lib/i18n/localize-issues";

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

function localizeActionLabel(label: string, actions?: Record<string, string>): string {
  if (!actions) return label;
  switch (label) {
    case "Retry routing": return actions.retryRouting ?? label;
    case "Verify DNS": return actions.verifyDns ?? label;
    case "Renew certificate": return actions.renewCert ?? label;
    case "Re-check certificate": return actions.recheckCert ?? label;
    case "Redeploy": return actions.redeploy ?? label;
    case "Keep": return actions.keep ?? label;
    case "Reject and roll back": return actions.rejectRollback ?? label;
    case "Dismiss warning": return actions.dismiss ?? label;
    default: return label;
  }
}

function localizeIssueTitle(rawTitle: string, titles?: Record<string, string>): string {
  if (!titles) return rawTitle;
  if (rawTitle === "Routing didn't sync") return titles.routingUnsynced ?? rawTitle;
  if (rawTitle.endsWith(" isn't verified")) {
    const hostname = rawTitle.slice(0, -" isn't verified".length);
    return titles.domainUnverified ? interpolate(titles.domainUnverified, { hostname }) : rawTitle;
  }
  const certExp = rawTitle.match(/^The certificate for (.*) expired$/);
  if (certExp) {
    return titles.certExpired ? interpolate(titles.certExpired, { hostname: certExp[1] }) : rawTitle;
  }
  const certFail = rawTitle.match(/^The certificate for (.*) failed$/);
  if (certFail) {
    return titles.certFailed ? interpolate(titles.certFailed, { hostname: certFail[1] }) : rawTitle;
  }
  if (rawTitle === "Some services failed — keep or reject this release") {
    return titles.partialDecision ?? rawTitle;
  }
  const portMatch = rawTitle.match(/^Port (\d+) in use$/);
  if (portMatch) {
    return titles.portInUse ? interpolate(titles.portInUse, { port: portMatch[1] }) : rawTitle;
  }
  return rawTitle;
}

function localizeIssueMessage(rawMsg: string, msgs?: Record<string, string>): string {
  if (!msgs) return rawMsg;
  if (rawMsg === "DNS for this hostname hasn't verified yet. Check the records, then re-run the check.") {
    return msgs.domainDnsUnverified ?? rawMsg;
  }
  if (rawMsg === "The deploy succeeded but its edge route didn't sync, so the public URL may not resolve yet. Retrying re-runs just the routing step — it does not rebuild.") {
    return msgs.routingUnsynced ?? rawMsg;
  }
  if (rawMsg === "HTTPS will fail for this hostname until a certificate is issued. Renewing re-runs issuance.") {
    return msgs.certHttpsWillFail ?? rawMsg;
  }
  if (rawMsg.startsWith("Some services failed to come up. The rest are live. Keep the release, or reject it to roll back to the previous one.")) {
    return msgs.partialServices ?? rawMsg;
  }
  const partNamed = rawMsg.match(/^These services failed: (.*?)\. The rest are live\. Keep the release, or reject it to roll back to the previous one\.$/);
  if (partNamed) {
    return msgs.partialNamedServices ? interpolate(msgs.partialNamedServices, { services: partNamed[1] }) : rawMsg;
  }
  if (rawMsg === "No usable HTTPS certificate was found on the server.") {
    return msgs.noCertOnServer ?? rawMsg;
  }
  if (rawMsg === "DNS points to a different server") {
    return msgs.dnsOtherServer ?? rawMsg;
  }
  if (rawMsg === "Ownership TXT record missing") {
    return msgs.txtMissing ?? rawMsg;
  }
  if (rawMsg === "The mail certificate has expired.") {
    return msgs.mailCertExpired ?? rawMsg;
  }
  const certEdge = rawMsg.match(/^Couldn't confirm a certificate \((.*?)\)\. Make sure the domain points at this server/);
  if (certEdge) {
    return msgs.certEdgeFailed ? interpolate(msgs.certEdgeFailed, { detail: certEdge[1] }) : rawMsg;
  }
  return localizeDiagnosisMessage(rawMsg, msgs);
}

export function IssueRow({
  issue,
  density = "compact",
  busy,
  onResolve,
  onInfraFix,
  onRecheck,
  rechecking,
}: {
  issue: SystemIssue;
  density?: AlertDensity;
  busy: boolean;
  onResolve: (issue: SystemIssue) => void;
  onInfraFix: (issue: SystemIssue) => void;
  onRecheck?: () => void;
  rechecking?: boolean;
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
  const actionLabel = fix ? localizeActionLabel(fix.label, (c as any).actionLabels) : "";
  const displayTitle = localizeIssueTitle(issue.title, (c as any).titles);
  const updating = issue.kind === "update_available" && (busy || issueUpdateInProgress(issue));
  const resolving = busy || updating;
  const connectionIssue = !issue.resolvedAt && isMonitoringConnectionIssue(issue);
  const affectedServers = Array.isArray(issue.details?.affectedServers)
    ? issue.details.affectedServers.filter((server): server is { name: string; reason?: string } =>
      !!server && typeof server === "object" && typeof server.name === "string")
    : [];
  const rawMessage = connectionIssue
    ? issue.kind === "monitoring_offline" ? c.connectivity.monitoringHint : c.connectivity.unknownHealth
    : issue.message;
  const message = connectionIssue ? rawMessage : localizeIssueMessage(rawMessage, (c as any).messages);
  const connectionDetail = issue.kind === "monitoring_offline"
    ? affectedServers.map((server) => `${server.name}: ${server.reason ?? ""}`).join("\n")
    : issue.message;

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
          {displayTitle}
        </Link>
      }
      label={kindLabel}
      action={
        selfUpdate ? (
          <CopyCommand
            command={SELF_UPDATE_COMMAND}
            className={cn("shrink-0", !compact && "h-8 max-w-full")}
          />
        ) : connectionIssue && onRecheck ? (
          <button type="button" onClick={onRecheck} disabled={rechecking} title={c.rescan} className={cn(actionClass, "disabled:opacity-60")}>
            <UiIcon name={rechecking ? "spinner" : "refresh"} className={cn("size-3", rechecking && "animate-spin")} />
            {rechecking ? c.rescanning : c.connectivity.recheck}
          </button>
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
            disabled={resolving}
            aria-busy={resolving}
            className={actionClass}
          >
            {resolving && <UiIcon name="spinner" className="size-3 animate-spin" />}
            {updating ? c.updating : actionLabel}
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
      {message && (
        <p
          className={`line-clamp-2 ${compact ? "text-[12px] leading-snug" : "text-[13px] leading-relaxed"} ${
            issue.severity === "advisory" ? "text-muted-foreground" : TEXT_TONE[tone]
          }`}
          title={message}
        >
          {message}
        </p>
      )}
      {connectionIssue && affectedServers.length > 0 && (
        <p className={cn("truncate", metaClass)} title={affectedServers.map((server) => server.name).join(", ")}>
          {affectedServers.map((server) => server.name).join(", ")}
        </p>
      )}
      {meta && <p className={cn("truncate", metaClass)}>{meta}</p>}
      {connectionIssue && connectionDetail && <details className={metaClass}>
        <summary className="cursor-pointer">{c.connectivity.details}</summary>
        <p className="mt-1 break-words whitespace-pre-wrap">{connectionDetail}</p>
      </details>}
      {selfUpdate && <p className={metaClass}>{c.selfUpdateNote}</p>}
    </AlertRow>
  );
}
