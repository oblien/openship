import type { ChangelogEntry } from "@/lib/changelog";
import { ShareButton } from "./share-button";

export type Entry = ChangelogEntry;

const TAG_STYLE: Record<string, { bg: string; fg: string }> = {
  feature: { bg: "var(--th-clr-sea-bg)", fg: "var(--th-clr-sea)" },
  fix: { bg: "rgba(147,197,253,.16)", fg: "#2563eb" },
  breaking: { bg: "var(--th-clr-terra-bg)", fg: "var(--th-clr-terra)" },
  security: { bg: "rgba(253,230,138,.30)", fg: "#b45309" },
};

function fmtDate(iso: string): { top: string; year: string } {
  const d = new Date(iso);
  return {
    top: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    year: String(d.getFullYear()),
  };
}

/**
 * Renders the changelog entry list. `highlightSlug` (set on `/changelog/<slug>`)
 * gives that one entry a highlighted card treatment; callers pin it to the top
 * so a shared link lands on it as entry #1.
 */
export function ChangelogEntries({
  entries,
  highlightSlug,
}: {
  entries: Entry[];
  highlightSlug?: string;
}) {
  return (
    <>
      {entries.map((entry) => {
        const highlighted = entry.slug === highlightSlug;
        const { top, year } = fmtDate(entry.date);
        return (
          <article
            key={entry.slug}
            id={entry.slug}
            className={`changelog-entry grid grid-cols-1 gap-4 py-12 sm:grid-cols-[140px_1fr] sm:gap-8 ${
              highlighted ? "changelog-highlight" : "border-t"
            }`}
            style={highlighted ? undefined : { borderColor: "var(--th-bd-subtle)" }}
          >
            <div className="sm:pt-1">
              <div className="th-text-title text-sm font-semibold">{top}</div>
              <div className="th-text-muted text-sm">{year}</div>
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="th-text-heading text-xl font-semibold tracking-[-0.01em]">
                  {entry.displayVersion}
                </span>
                {entry.tags.map((t) => {
                  const s =
                    TAG_STYLE[t] ?? {
                      bg: "var(--th-sf-06)",
                      fg: "var(--th-text-secondary)",
                    };
                  return (
                    <span
                      key={t}
                      className="rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ background: s.bg, color: s.fg }}
                    >
                      {t}
                    </span>
                  );
                })}
                <ShareButton slug={entry.slug} className="ml-auto" />
              </div>
              <div
                className="changelog-prose th-text-body mt-4 text-[15px] leading-relaxed"
                dangerouslySetInnerHTML={{ __html: entry.html }}
              />
            </div>
          </article>
        );
      })}
    </>
  );
}
