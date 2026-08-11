"use client";

import { useI18n } from "@/components/i18n-provider";

import { IssuesIllustration } from "./IssuesIllustration";

/**
 * Three distinct nothings, because they mean different things: nothing is wrong,
 * nothing has recovered yet, and nothing matches the filter you typed.
 *
 * One geometry serves all three — the illustration is the IssueGroup panel this page
 * renders, and the variants differ by what that panel is DOING (holding a slot open,
 * remembering, masked by a lens) rather than by a tint. That is what lets one component
 * say which nothing this is without any of the three lying: "no resolved incidents" must
 * never read as "your fleet is healthy", and a narrowed page must never read as either.
 *
 * No fetching, so the page, the fixture preview and the render test all show the same
 * nothing.
 */
export function EmptyIssues({ filtered, resolved }: { filtered: boolean; resolved: boolean }) {
  const { t } = useI18n();
  const c = t.issues.empty;

  // `filtered` short-circuits FIRST — same precedence as the nested ternary this
  // replaces, so {filtered:true, resolved:true} still renders the filter copy.
  const variant = filtered ? "filtered" : resolved ? "resolved" : "open";
  const [title, body] =
    variant === "filtered"
      ? [c.filteredTitle, c.filteredBody]
      : variant === "resolved"
        ? [c.resolvedTitle, c.resolvedBody]
        : [c.openTitle, c.openBody];

  // The filtered state is the only one that mounts inside `1fr` of
  // lg:grid-cols-[1fr_340px], right above the `{filtered.length} / {counts.total}`
  // counter — the only thing telling the operator how much is hidden. Smaller art keeps
  // that line attached instead of orphaning it below a full-size illustration.
  const narrow = variant === "filtered";

  return (
    <div
      className={`rounded-2xl border border-border/50 bg-card px-6 text-center ${
        narrow ? "py-10" : "py-14"
      }`}
    >
      <IssuesIllustration
        variant={variant}
        className={
          narrow
            ? "relative mx-auto mb-4 h-32 w-56 max-w-full"
            : "relative mx-auto mb-6 h-36 w-64 max-w-full"
        }
      />
      <h3 className="text-[15px] font-medium text-foreground" style={{ letterSpacing: "-0.2px" }}>
        {title}
      </h3>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-muted-foreground/80">
        {body}
      </p>
    </div>
  );
}
