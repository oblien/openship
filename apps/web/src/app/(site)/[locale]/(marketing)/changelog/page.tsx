import { localizedMetadata } from "@/i18n/metadata";

import { getCopy } from "@/i18n/copy-server";
import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { getChangelog } from "@/lib/changelog";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { ChangelogEntries } from "./_components/changelog-entries";
import "./changelog.css";

const CHANGELOG_DESC = "New features, fixes, and improvements to OpenShip.";

// Driven by the repo CHANGELOG.md + GitHub releases; refresh on a short cache.
export const revalidate = 600;

const metadata: Metadata = {
  // Plain string — the root layout's "%s - OpenShip" template adds the suffix
  // (the old value double-suffixed to "Changelog – OpenShip - OpenShip").
  title: "Changelog",
  description: CHANGELOG_DESC,
  alternates: { canonical: "/changelog" },
  openGraph: {
    title: "Changelog - OpenShip",
    description: CHANGELOG_DESC,
    url: "/changelog",
    type: "website",
    siteName: "OpenShip",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Changelog - OpenShip",
    description: CHANGELOG_DESC,
  },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default async function ChangelogPage() {
  const copy = await getCopy();

  const entries = await getChangelog();

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-28 sm:pt-32">
        <header className="mb-8 max-w-2xl">
          <span className="th-text-secondary text-[13px] font-medium uppercase tracking-[0.14em]">
            {copy("Changelog")}
          </span>
          <h1 className="th-text-heading mt-4 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
            {copy("What's new")}
          </h1>
          <p className="th-text-body mt-5 text-lg leading-relaxed">
            {copy("Features, fixes, and improvements shipping in OpenShip.")}
          </p>
        </header>

        {entries.length > 0 ? (
          <ChangelogEntries entries={entries} />
        ) : (
          <p
            className="th-text-muted border-t py-12 text-[15px]"
            style={{ borderColor: "var(--th-bd-subtle)" }}
          >
            {copy("Release notes are momentarily unavailable — check back shortly, or see")}{" "}
            <a
              href="https://github.com/oblien/openship/releases"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              {copy("releases on GitHub")}
            </a>
            .
          </p>
        )}
      </main>
      <Footer />
    </>
  );
}
