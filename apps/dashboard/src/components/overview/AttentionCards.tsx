"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, ArrowUpCircle, X } from "lucide-react";

import type { SystemIssue } from "@/lib/api/issues";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { IssueRow } from "@/components/issues/IssueRow";
import AlertPanel, { type AlertTone } from "./AlertPanel";

/**
 * The two home attention cards, with no data fetching of their own.
 *
 * Presentation is split from {@link UpdatesBlock} for the same reason the Monitoring
 * tab has a fixture preview: these cards only render when real infrastructure is
 * broken or behind, so judging their layout otherwise means stopping a container on a
 * live box. `/dev/attention` renders every state from fixtures instead.
 *
 * Both cards are windows onto the SAME feed `/issues` serves, and they render its
 * rows with the same {@link IssueRow} that page uses. That's deliberate: this card
 * used to see only edge/mail container state, so a crash loop that had already paged
 * Telegram was invisible on the panel titled "Needs attention". Now the split is by
 * severity — what is broken (outage / action required) above what is merely behind
 * (advisories) — and the definition of each lives server-side, once.
 */

/**
 * A sidebar card is not a table: past a few entries it stops being glanceable and
 * starts pushing the rest of the column off screen. Both lists cap and hand the
 * remainder to the surface that IS built for the whole fleet — `/issues`.
 */
const MAX_ISSUE_ROWS = 3;
const MAX_UPDATE_ROWS = 4;

const FOOTER_LINK =
  "inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground";

/** Muted in every tone: a red X on the outage card would read as the fix. */
const HIDE_BUTTON =
  "inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground";

interface CardProps {
  issues: SystemIssue[];
  /** Id of the row whose fix is currently running, if any. */
  busyId?: string | null;
  onResolve: (issue: SystemIssue) => void;
  onInfraFix: (issue: SystemIssue) => void;
  /**
   * Clear the card off the home page until this set of issues changes. Optional so a
   * surface that isn't the home column (the fixture preview) can leave it out.
   */
  onHide?: () => void;
}

/** The shared body: capped rows plus the overflow line into the full feed. */
function AttentionCard({
  tone,
  icon,
  title,
  subtitle,
  max,
  issues,
  busyId,
  onResolve,
  onInfraFix,
  onHide,
}: CardProps & {
  tone: AlertTone;
  icon: typeof AlertTriangle;
  title: string;
  subtitle: string;
  max: number;
}) {
  const { t } = useI18n();
  const c = t.issues.home;

  const shown = issues.slice(0, max);
  const hidden = issues.length - shown.length;

  return (
    <AlertPanel
      tone={tone}
      icon={icon}
      title={title}
      subtitle={subtitle}
      count={issues.length}
      // Hiding is scoped to the home page and to THIS set of issues — it expires, and a
      // new problem brings the card straight back (see `lib/attention-hide`). So the
      // outage card is dismissible too: an operator mid-repair on a box they already
      // know about shouldn't have to look at it, and nothing else about the issue
      // changes — `/issues` still lists it, and the notification already went out.
      headerAction={
        onHide && (
          <button
            type="button"
            onClick={onHide}
            title={c.hide}
            aria-label={c.hide}
            className={HIDE_BUTTON}
          >
            <X className="size-3.5" />
          </button>
        )
      }
      // The footer is the card's way into the tracker, so it renders whether or not
      // anything overflowed — a card that only became clickable at four rows read as
      // "there is more" rather than "here is the full list".
      footer={
        <Link href="/issues" className={FOOTER_LINK}>
          {hidden > 0 ? interpolate(c.more, { n: String(hidden) }) : t.dashboard.home.viewAll}
          <ArrowRight className="size-3.5 rtl:rotate-180" />
        </Link>
      }
    >
      <ul className="divide-y divide-border/50">
        {shown.map((issue) => (
          <IssueRow
            key={issue.id}
            issue={issue}
            busy={busyId === issue.id}
            onResolve={onResolve}
            onInfraFix={onInfraFix}
          />
        ))}
      </ul>
    </AlertPanel>
  );
}

/**
 * What's broken right now — a down edge, a crash-looping container, an unreachable
 * box, a failed certificate. Each row carries its own remediation, which is the point
 * of the card; the feed is one click away for anything this list can't finish.
 */
export function IssuesCard(props: CardProps) {
  const { t } = useI18n();
  const c = t.issues.home;
  // An edge that was never installed or a cert waiting on DNS is not an outage, so
  // the card only escalates to danger when something that WAS serving stopped. The
  // tiers themselves come from the feed — this reads them, it doesn't re-judge them.
  const tone: AlertTone = props.issues.some((i) => i.severity === "outage")
    ? "danger"
    : "warning";

  return (
    <AttentionCard
      {...props}
      tone={tone}
      icon={AlertTriangle}
      title={c.attentionTitle}
      subtitle={c.attentionSubtitle}
      max={MAX_ISSUE_ROWS}
    />
  );
}

/**
 * What's merely behind: project releases, plus managed edge/mail image drift.
 *
 * Amber, like the card this replaced. It reads as an offer rather than an alarm because
 * of what it does NOT have — no red, no solid buttons (its rows keep the neutral ghost
 * control), and a title that says "Updates available" next to an up-arrow. On the
 * `/issues` page an advisory still groups on the muted surface: there it sits directly
 * under outage and action-required panels, where amber would be one tier too loud.
 */
export function UpdatesCard(props: CardProps) {
  const { t } = useI18n();
  const c = t.issues.home;

  return (
    <AttentionCard
      {...props}
      tone="warning"
      icon={ArrowUpCircle}
      title={c.updatesTitle}
      subtitle={c.updatesSubtitle}
      max={MAX_UPDATE_ROWS}
    />
  );
}
