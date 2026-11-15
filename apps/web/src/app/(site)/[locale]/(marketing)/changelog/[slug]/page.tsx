import { localizedMetadata } from "@/i18n/metadata";

import { getCopy } from "@/i18n/copy-server";
import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Link } from "@/i18n/Link";
import { notFound } from "next/navigation";
import { getChangelog } from "@/lib/changelog";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { ChangelogEntries, type Entry } from "../_components/changelog-entries";
import "../changelog.css";

type Params = Promise<{ slug: string }>;

// Driven by the repo CHANGELOG.md + GitHub releases; refresh on a short cache.
export const revalidate = 600;

export async function generateStaticParams() {
  const entries = await getChangelog();
  return entries.map((e) => ({ slug: e.slug }));
}

export async function generateMetadata(
  { params }: { params: Params },
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const { slug } = await params;
  const entry = (await getChangelog()).find((e) => e.slug === slug);
  if (!entry) return { title: "Changelog" };

  const title = entry.displayVersion;
  const description = entry.summary || "Features, fixes, and improvements shipping in OpenShip.";
  const url = `/changelog/${slug}`;

  const metadata: Metadata = {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${title} - OpenShip`,
      description,
      url,
      type: "article",
      siteName: "OpenShip",
      locale: "en_US",
      publishedTime: entry.date,
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} - OpenShip`,
      description,
    },
  };
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default async function ChangelogEntryPage({ params }: { params: Params }) {
  const copy = await getCopy();

  const { slug } = await params;
  const entries = await getChangelog();
  const target = entries.find((e) => e.slug === slug);
  if (!target) notFound();

  // The archive lives at /changelog. Keep each release URL focused on its release.
  const ordered: Entry[] = [target];

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-28 sm:pt-32">
        <header className="mb-8 max-w-2xl">
          <Link
            href="/changelog"
            className="th-text-secondary text-[13px] font-medium uppercase tracking-[0.14em] transition-colors hover:opacity-80"
          >
            {copy("← Changelog")}
          </Link>
          <h1 className="th-text-heading mt-4 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
            {copy(target.displayVersion)}
          </h1>
          <p className="th-text-body mt-5 text-lg leading-relaxed">
            {target.summary || "Features, fixes, and improvements shipping in OpenShip."}
          </p>
        </header>

        <ChangelogEntries entries={ordered} highlightSlug={slug} />
      </main>
      <Footer />
    </>
  );
}
