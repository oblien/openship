"use client";

/**
 * Top Paths, switched off.
 *
 * Same illustration language and `--th-*` token family as `components/jobs/JobsEmptyState`
 * and `components/overview/EmptyState` — a card motif with muted bars, one accent, and
 * scattered decorative dots — so an off card reads as part of the app rather than as a
 * hole in it.
 *
 * The copy says WHY it is off, which matters here in a way it doesn't for an ordinary empty
 * state: this is the only analytics dimension that is opt-in, and without the reason an
 * operator reasonably reads it as something Openship forgot to turn on.
 */

import { TrendingUp, Zap } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface Props {
  onEnable: () => void;
  /** True while the toggle is in flight, so the button can't be double-fired. */
  isBusy?: boolean;
}

export function TopPathsEmptyState({ onEnable, isBusy = false }: Props) {
  const { t } = useI18n();
  const e = t.projects.monitoring.pathsOff;

  return (
    <div className="rounded-2xl bg-card p-5">
      {/* Byte-identical header to the populated card (TopPaths.tsx) — same icon, same
          weight. Two different headers made enabling look like the card was replaced by a
          different one rather than filled in. */}
      <div className="mb-5 flex items-center gap-2">
        <TrendingUp className="size-5 text-primary" />
        <h3 className="text-base font-semibold text-foreground">
          {t.projectDetail.general.topPaths.title}
        </h3>
      </div>

      <div className="py-2 text-center">
        <div className="relative mx-auto mb-5 h-32 w-52 max-w-full">
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 220 140" fill="none">
            {/* Card stack, same three-layer motif as the other empty states */}
            <rect x="52" y="40" width="118" height="76" rx="12" fill="var(--th-sf-04)" />
            <rect x="42" y="32" width="118" height="76" rx="12" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
            <rect x="32" y="24" width="118" height="76" rx="12" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />

            {/* A path list with its bars — what the card shows when it's on. Descending
                widths so the shape reads as a ranking even without numbers. */}
            <rect x="44" y="36" width="34" height="5" rx="2.5" fill="var(--th-on-12)" />
            <rect x="44" y="45" width="82" height="5" rx="2.5" fill="var(--th-on-08)" />

            <rect x="44" y="58" width="46" height="5" rx="2.5" fill="var(--th-on-10)" />
            <rect x="44" y="67" width="54" height="5" rx="2.5" fill="var(--th-on-06)" />

            <rect x="44" y="80" width="28" height="5" rx="2.5" fill="var(--th-on-10)" />
            <rect x="44" y="89" width="30" height="5" rx="2.5" fill="var(--th-on-06)" />

            {/* The single accent: a lightning bolt in a dashed ring, for "costs something
                to collect". Dashed = not currently running, matching the house CTA ring. */}
            <circle cx="176" cy="72" r="20" fill="var(--th-on-05)" />
            <circle cx="176" cy="72" r="14" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
            <path d="M178 64l-6 9h4l-2 7 6-9h-4l2-7z" fill="#f59e0b" fillOpacity="0.75" />

            {/* Dashed connector: the list → what it costs */}
            <path d="M152 74 Q159 72 162 72" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />

            {/* Decorative dots + sparkle, matching the family */}
            <circle cx="18" cy="52" r="4" fill="var(--th-on-10)" />
            <circle cx="26" cy="112" r="4.5" fill="var(--th-on-08)" />
            <circle cx="12" cy="86" r="2.5" fill="var(--th-on-06)" />
            <circle cx="200" cy="36" r="3" fill="var(--th-on-12)" />
            <circle cx="196" cy="116" r="3.5" fill="var(--th-on-06)" />
            <path d="M14 68l1.8-3.6 1.8 3.6-3.6-1.8 3.6 0-3.6 1.8z" fill="var(--th-on-16)" />
          </svg>
        </div>

        <h4
          className="mb-2 text-base font-medium text-foreground/80"
          style={{ letterSpacing: "-0.2px" }}
        >
          {e.title}
        </h4>
        <p className="mx-auto mb-5 max-w-sm text-xs leading-relaxed text-muted-foreground/70">
          {/* The measured share, stated. "It's expensive" invites doubt; "57% of the
              per-request work" is checkable and settles the question. */}
          {interpolate(e.desc, { share: "57%" })}
        </p>

        <button
          type="button"
          onClick={onEnable}
          disabled={isBusy}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          <Zap className="size-4" />
          {isBusy ? e.enabling : e.cta}
        </button>
      </div>
    </div>
  );
}
