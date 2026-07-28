import type { Metadata } from "next";
import Link from "next/link";
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

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const entry = (await getChangelog()).find((e) => e.slug === slug);
  if (!entry) return { title: "Changelog" };

  const title = entry.displayVersion;
  const description = entry.summary || "Features, fixes, and improvements shipping in Openship.";
  const url = `/changelog/${slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${title} - Openship`,
      description,
      url,
      type: "article",
      siteName: "Openship",
      locale: "en_US",
      publishedTime: entry.date,
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} - Openship`,
      description,
    },
  };
}

export default async function ChangelogEntryPage({ params }: { params: Params }) {
  const { slug } = await params;
  const entries = await getChangelog();
  const target = entries.find((e) => e.slug === slug);
  if (!target) notFound();

  // Pin the shared entry to the top (#1); the rest follow (already newest-first).
  const ordered: Entry[] = [target, ...entries.filter((e) => e.slug !== slug)];

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-28 sm:pt-32">
        <header className="mb-8 max-w-2xl">
          <Link
            href="/changelog"
            className="th-text-secondary text-[13px] font-medium uppercase tracking-[0.14em] transition-colors hover:opacity-80"
          >
            ← Changelog
          </Link>
          <h1 className="th-text-heading mt-4 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
            {target.displayVersion}
          </h1>
          <p className="th-text-body mt-5 text-lg leading-relaxed">
            {target.summary || "Features, fixes, and improvements shipping in Openship."}
          </p>
        </header>

        <ChangelogEntries entries={ordered} highlightSlug={slug} />
      </main>
      <Footer />
    </>
  );
}
