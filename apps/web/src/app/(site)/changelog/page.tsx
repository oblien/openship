import type { Metadata } from "next";
import { changelogSource, type ChangelogFrontmatter } from "@/lib/source";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import "./changelog.css";

const CHANGELOG_DESC = "New features, fixes, and improvements to Openship.";

export const metadata: Metadata = {
  // Plain string — the root layout's "%s - Openship" template adds the suffix
  // (the old value double-suffixed to "Changelog – Openship - Openship").
  title: "Changelog",
  description: CHANGELOG_DESC,
  alternates: { canonical: "/changelog" },
  openGraph: {
    title: "Changelog - Openship",
    description: CHANGELOG_DESC,
    url: "/changelog",
    type: "website",
    siteName: "Openship",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Changelog - Openship",
    description: CHANGELOG_DESC,
  },
};

type Entry = { url: string; data: ChangelogFrontmatter };

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

export default function ChangelogPage() {
  const entries = (changelogSource.getPages() as unknown as Entry[])
    .slice()
    .sort(
      (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime(),
    );

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-28 sm:pt-32">
        <header className="mb-8 max-w-2xl">
          <span className="th-text-secondary text-[13px] font-medium uppercase tracking-[0.14em]">
            Changelog
          </span>
          <h1 className="th-text-heading mt-4 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
            What&apos;s new
          </h1>
          <p className="th-text-body mt-5 text-lg leading-relaxed">
            Features, fixes, and improvements shipping in Openship.
          </p>
        </header>

        {entries.map((entry) => {
          const { top, year } = fmtDate(entry.data.date);
          const Body = entry.data.body;
          return (
            <article
              key={entry.url}
              className="grid grid-cols-1 gap-4 border-t py-12 sm:grid-cols-[140px_1fr] sm:gap-8"
              style={{ borderColor: "var(--th-bd-subtle)" }}
            >
              <div className="sm:pt-1">
                <div className="th-text-title text-sm font-semibold">{top}</div>
                <div className="th-text-muted text-sm">{year}</div>
              </div>

              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="th-text-heading text-xl font-semibold tracking-[-0.01em]">
                    {entry.data.version}
                  </span>
                  {(entry.data.tags ?? []).map((t) => {
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
                </div>
                {entry.data.title && (
                  <h2 className="th-text-title mt-2 text-lg font-medium">
                    {entry.data.title}
                  </h2>
                )}
                <div className="changelog-prose th-text-body mt-4 text-[15px] leading-relaxed">
                  <Body />
                </div>
              </div>
            </article>
          );
        })}
      </main>
      <Footer />
    </>
  );
}
