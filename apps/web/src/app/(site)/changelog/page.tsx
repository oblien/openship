import type { Metadata } from "next";
import { getChangelog } from "@/lib/changelog";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { ChangelogEntries } from "./_components/changelog-entries";
import "./changelog.css";

const CHANGELOG_DESC = "New features, fixes, and improvements to Openship.";

// Driven by the repo CHANGELOG.md + GitHub releases; refresh on a short cache.
export const revalidate = 600;

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

export default async function ChangelogPage() {
  const entries = await getChangelog();

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

        {entries.length > 0 ? (
          <ChangelogEntries entries={entries} />
        ) : (
          <p className="th-text-muted border-t py-12 text-[15px]" style={{ borderColor: "var(--th-bd-subtle)" }}>
            Release notes are momentarily unavailable — check back shortly, or see{" "}
            <a
              href="https://github.com/oblien/openship/releases"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              releases on GitHub
            </a>
            .
          </p>
        )}
      </main>
      <Footer />
    </>
  );
}
