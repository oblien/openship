"use client";

import { Plus, BookOpen, ExternalLink } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

const DOCS_URL = "https://openship.io/docs";

/**
 * Empty state for the custom-jobs section — same illustration language + theme
 * tokens as the projects empty state (components/overview/EmptyState.tsx), with
 * a jobs motif: a terminal card with a clock badge and a run button.
 */
export function JobsEmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  const e = t.jobs.customEmpty;

  return (
    <div className="py-6 text-center">
      <div className="relative mx-auto mb-5 h-40 w-60 max-w-full">
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 260 180" fill="none">
          {/* Card stack */}
          <rect x="78" y="52" width="132" height="92" rx="14" fill="var(--th-sf-04)" />
          <rect x="66" y="42" width="132" height="92" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <rect x="54" y="30" width="132" height="92" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />

          {/* Header bar (window chrome + title) */}
          <path d="M54 44a14 14 0 0 1 14-14h104a14 14 0 0 1 14 14v6H54z" fill="var(--th-sf-05)" />
          <circle cx="70" cy="40" r="3.5" fill="var(--th-on-20)" />
          <circle cx="82" cy="40" r="3.5" fill="var(--th-on-16)" />
          <circle cx="94" cy="40" r="3.5" fill="var(--th-on-12)" />
          <rect x="150" y="37" width="28" height="6" rx="3" fill="var(--th-on-10)" />

          {/* Run-entry rows (command + timestamp lines) */}
          <rect x="88" y="58" width="52" height="6" rx="3" fill="var(--th-on-12)" />
          <rect x="88" y="69" width="30" height="4" rx="2" fill="var(--th-on-08)" />
          <rect x="88" y="81" width="46" height="6" rx="3" fill="var(--th-on-10)" />
          <rect x="88" y="92" width="36" height="4" rx="2" fill="var(--th-on-08)" />
          <rect x="88" y="104" width="50" height="6" rx="3" fill="var(--th-on-10)" />
          <rect x="88" y="115" width="28" height="4" rx="2" fill="var(--th-on-08)" />

          {/* Timeline spine */}
          <path d="M72 62V108" stroke="var(--th-on-16)" strokeWidth="1.5" strokeLinecap="round" />

          {/* Older run nodes (muted status ticks) */}
          <circle cx="72" cy="108" r="6" fill="var(--th-on-05)" stroke="var(--th-on-20)" strokeWidth="1.5" />
          <path d="M69 108l2 2 4-5" stroke="var(--th-on-40)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <circle cx="72" cy="85" r="6" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="1.5" />
          <path d="M69 85l2 2 4-5" stroke="var(--th-on-40)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />

          {/* Latest run node — the single color accent (success) */}
          <circle cx="72" cy="62" r="8.5" fill="#22c55e" fillOpacity="0.12" />
          <circle cx="72" cy="62" r="6" fill="var(--th-card-bg)" stroke="#22c55e" strokeOpacity="0.5" strokeWidth="1.5" />
          <path d="M69 62l2 2 4-5" stroke="#22c55e" strokeOpacity="0.8" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />

          {/* Scheduled-run clock affordance (house dashed CTA circle) */}
          <circle cx="214" cy="86" r="22" fill="var(--th-on-05)" />
          <circle cx="214" cy="86" r="16" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
          <circle cx="214" cy="74" r="1" fill="var(--th-on-16)" />
          <circle cx="226" cy="86" r="1" fill="var(--th-on-16)" />
          <circle cx="214" cy="98" r="1" fill="var(--th-on-16)" />
          <circle cx="202" cy="86" r="1" fill="var(--th-on-16)" />
          <path d="M214 86V78M214 86l5 3" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="214" cy="86" r="1.6" fill="var(--th-on-40)" />

          {/* Dashed connector: history → next run */}
          <path d="M186 90 Q194 87 198 87" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />

          {/* Decorative dots + sparkles */}
          <circle cx="30" cy="64" r="4.5" fill="var(--th-on-10)" />
          <circle cx="44" cy="150" r="5" fill="var(--th-on-08)" />
          <circle cx="22" cy="112" r="3" fill="var(--th-on-06)" />
          <circle cx="236" cy="50" r="3.5" fill="var(--th-on-12)" />
          <circle cx="228" cy="146" r="4" fill="var(--th-on-06)" />
          <circle cx="250" cy="98" r="3" fill="var(--th-on-08)" />
          <path d="M24 96l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
          <path d="M243 122l1.8-3.6 1.8 3.6-3.6-1.8 3.6 0-3.6 1.8z" fill="var(--th-on-12)" />
        </svg>
      </div>

      <h3 className="mb-2 text-xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
        {e.title}
      </h3>
      <p className="mx-auto mb-6 max-w-md text-sm leading-relaxed text-muted-foreground">{e.desc}</p>

      <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
        <button
          onClick={onCreate}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Plus className="size-4" />
          {e.cta}
        </button>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-xl bg-muted/50 px-6 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          <BookOpen className="size-4" />
          {e.docs}
          <ExternalLink className="size-3.5 opacity-60" />
        </a>
      </div>
    </div>
  );
}
