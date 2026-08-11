import type { ChangelogEntry, ChangelogSection } from "@/lib/changelog";
import { ShareButton } from "./share-button";
import { ChangelogControls } from "./changelog-controls";

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

function Chevron({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One `### ` group: a label, its bullets, and any trailing note paragraphs. */
function Section({ section }: { section: ChangelogSection }) {
  return (
    <section className="cl-section">
      {section.title ? <h3 className="cl-section-title">{section.title}</h3> : null}

      {section.items.length > 0 ? (
        <ul className="cl-items">
          {section.items.map((item) =>
            item.detailHtml ? (
              <li className="cl-item" key={item.title}>
                <details className="cl-item-details">
                  <summary className="cl-item-sum">
                    <Chevron className="cl-chev cl-chev--item" />
                    <span
                      className="cl-item-title"
                      dangerouslySetInnerHTML={{ __html: item.title }}
                    />
                  </summary>
                  <div
                    className="cl-item-detail changelog-prose"
                    dangerouslySetInnerHTML={{ __html: item.detailHtml }}
                  />
                </details>
              </li>
            ) : (
              // A one-liner has nothing to open — render it flat, not as a dead toggle.
              <li className="cl-item cl-item--flat" key={item.title}>
                <span className="cl-dot" aria-hidden="true" />
                <span className="cl-item-title" dangerouslySetInnerHTML={{ __html: item.title }} />
              </li>
            ),
          )}
        </ul>
      ) : null}

      {section.notesHtml.map((note) => (
        <div
          key={note}
          className="cl-note changelog-prose"
          dangerouslySetInnerHTML={{ __html: note }}
        />
      ))}
    </section>
  );
}

/**
 * Renders the changelog as three collapsed tiers — version → item → detail — so a
 * page carrying every release opens as a short scannable list instead of many
 * screens of prose, and a closed tier costs no layout or paint.
 *
 * Native `<details>` on purpose: no client JS, no hydration payload (this stays a
 * server component, so the entry HTML is never serialized), and closed content is
 * still in the document for crawlers and find-in-page.
 *
 * The open version is the newest one, or — on `/changelog/<slug>` — the shared
 * entry, which `highlightSlug` also gives a highlighted card treatment. Callers
 * pin that entry to the top so a shared link lands on it as entry #1.
 */
export function ChangelogEntries({
  entries,
  highlightSlug,
}: {
  entries: Entry[];
  highlightSlug?: string;
}) {
  return (
    <div className="cl-list">
      <ChangelogControls releaseCount={entries.length} />

      {entries.map((entry, i) => {
        const highlighted = entry.slug === highlightSlug;
        const { top, year } = fmtDate(entry.date);
        return (
          <article
            key={entry.slug}
            id={entry.slug}
            className={`changelog-entry cl-entry ${highlighted ? "changelog-highlight" : ""}`}
          >
            <details className="cl-version" open={highlightSlug ? highlighted : i === 0}>
              <summary className="cl-version-sum">
                <span className="cl-date">
                  <span className="cl-date-top">{top}</span>
                  <span className="cl-date-year">{year}</span>
                </span>

                <span className="cl-version-head">
                  <Chevron className="cl-chev cl-chev--version" />
                  <span className="cl-version-num">{entry.displayVersion}</span>

                  {entry.tags.map((t) => {
                    const s = TAG_STYLE[t] ?? {
                      bg: "var(--th-sf-06)",
                      fg: "var(--th-text-secondary)",
                    };
                    return (
                      <span className="cl-tag" key={t} style={{ background: s.bg, color: s.fg }}>
                        {t}
                      </span>
                    );
                  })}

                  <span className="cl-count">
                    {entry.itemCount} {entry.itemCount === 1 ? "update" : "updates"}
                  </span>
                  <ShareButton slug={entry.slug} className="cl-share" />
                </span>
              </summary>

              <div className="cl-version-body">
                {/* On /changelog/<slug> the page header already carries this entry's
                    lead paragraph — don't print it twice. */}
                {entry.leadHtml && !highlighted ? (
                  <div
                    className="cl-lead changelog-prose"
                    dangerouslySetInnerHTML={{ __html: entry.leadHtml }}
                  />
                ) : null}
                {entry.sections.map((section) => (
                  <Section key={section.title || "intro"} section={section} />
                ))}
              </div>
            </details>
          </article>
        );
      })}
    </div>
  );
}
