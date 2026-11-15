import { getLocale } from "next-intl/server";
import { localizedMetadata } from "@/i18n/metadata";

import { getCopy } from "@/i18n/copy-server";
import { reportCaughtError } from "@repo/core/diagnostics";
import { Link } from "@/i18n/Link";
import { blogSource, type BlogFrontmatter } from "@/lib/source";
import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";

const SITE_URL = "https://openship.io";

type RPage = { url: string; data: BlogFrontmatter };
type SearchParams = Promise<{ category?: string | string[] }>;

function selectedCategory(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.toLowerCase() || "all";
}

function getPages(locale: string): RPage[] {
  return blogSource.getPages(locale) as unknown as RPage[];
}

function getCategories(locale: string) {
  const pages = getPages(locale);
  const set = new Set<string>();
  pages.forEach((p) => {
    if (p.data?.category) set.add(p.data.category);
  });
  return [
    { name: "All", slug: "all" },
    ...[...set].sort().map((c) => ({ name: c, slug: c.toLowerCase() })),
  ];
}

function formatDate(raw: string, locale: string): string {
  try {
    return new Date(raw).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch (error) {
    reportCaughtError(error, "web/app/(site)/blog/page");
    return raw;
  }
}

export async function generateMetadata(
  {
    searchParams,
  }: {
    searchParams: SearchParams;
  },
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const search = await searchParams;
  const category = selectedCategory(search.category);

  const pageTitle =
    category && category !== "all"
      ? `${category.charAt(0).toUpperCase() + category.slice(1)} – OpenShip Blog`
      : "Blog – OpenShip";

  const pageDescription =
    category && category !== "all"
      ? `Browse ${category} articles, guides, and updates from the OpenShip team`
      : "Engineering deep-dives, product updates, and guides from the OpenShip team.";

  const metadata: Metadata = {
    title: pageTitle,
    description: pageDescription,
    openGraph: {
      title: pageTitle,
      description: pageDescription,
      url: `${SITE_URL}/blog${category && category !== "all" ? `?category=${encodeURIComponent(category)}` : ""}`,
      siteName: "OpenShip",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: pageTitle,
      description: pageDescription,
    },
    alternates: {
      canonical: `${SITE_URL}/blog`,
    },
  };
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default async function BlogPage({ searchParams }: { searchParams: SearchParams }) {
  const copy = await getCopy();
  const locale = await getLocale();

  const search = await searchParams;
  const category = selectedCategory(search.category);

  let pages = getPages(locale);
  const categories = getCategories(locale);

  if (category !== "all") {
    pages = pages.filter((p) => (p.data?.category?.toLowerCase() || "") === category.toLowerCase());
  }

  pages.sort((a, b) => {
    const da = a.data.date ?? "";
    const db = b.data.date ?? "";
    return db.localeCompare(da);
  });

  const featured = pages[0] || null;
  const rest = pages.slice(1);

  const blogStructuredData = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: copy("OpenShip Blog"),
    description: copy("Engineering deep-dives, product updates, and guides from the OpenShip team"),
    url: `${SITE_URL}/blog`,
    publisher: {
      "@type": "Organization",
      name: "OpenShip",
    },
    blogPost: pages.slice(0, 10).map((page) => ({
      "@type": "BlogPosting",
      headline: page.data.title,
      description: page.data.description,
      url: `${SITE_URL}${page.url}`,
      datePublished: page.data.date,
      author: { "@type": "Person", name: page.data.author || "OpenShip Team" },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogStructuredData) }}
      />

      <main className="res-main">
        <section className="res-hero">
          <span className="res-eyebrow">{copy("The OpenShip blog")}</span>
          <h1 className="res-title">{copy("Notes from the build.")}</h1>
          <p className="res-sub">
            {copy(
              "Engineering deep-dives, product updates, and guides from the OpenShip team - straight from the source.",
            )}
          </p>
          <Link href="/blog/rss.xml" className="res-feed">
            {copy("Follow via RSS ")}
            <span aria-hidden="true">↗</span>
          </Link>
        </section>

        <nav className="res-tabs" aria-label={copy("Categories")}>
          {categories.map((cat) => {
            const href =
              cat.slug === "all" ? "/blog" : `/blog?category=${encodeURIComponent(cat.slug)}`;
            const active = category === cat.slug;
            return (
              <Link
                key={cat.slug}
                href={href}
                className="res-tab"
                data-active={active ? "true" : "false"}
                aria-current={active ? "page" : undefined}
              >
                {copy(cat.name)}
              </Link>
            );
          })}
        </nav>

        {featured && (
          <Link href={featured.url} className="res-featured">
            <div className="res-featured-flag">{copy("Featured")}</div>
            <span className="res-featured-tag">{featured.data.category || "Post"}</span>
            <h2 className="res-featured-title">{copy(featured.data.title)}</h2>
            {featured.data.description && (
              <p className="res-featured-desc">{copy(featured.data.description)}</p>
            )}
            <div className="res-featured-meta">
              <div className="res-avatar" aria-hidden="true">
                {(featured.data.author || "O")[0].toUpperCase()}
              </div>
              <span className="res-meta-name">{featured.data.author || "OpenShip Team"}</span>
              {featured.data.date && (
                <>
                  <span className="res-meta-dot" aria-hidden="true" />
                  <time dateTime={featured.data.date}>
                    {formatDate(featured.data.date, locale)}
                  </time>
                </>
              )}
            </div>
          </Link>
        )}

        {rest.length > 0 && (
          <div className="res-grid">
            {rest.map((post) => (
              <Link key={post.url} href={post.url} className="res-card">
                <div className="res-card-top">
                  <span className="res-card-tag">{post.data.category || "Post"}</span>
                  {post.data.date && (
                    <time className="res-card-date" dateTime={post.data.date}>
                      {formatDate(post.data.date, locale)}
                    </time>
                  )}
                </div>
                <h3 className="res-card-title">{copy(post.data.title)}</h3>
                {post.data.description && (
                  <p className="res-card-desc">{copy(post.data.description)}</p>
                )}
                <div className="res-card-foot">
                  <div className="res-avatar" aria-hidden="true">
                    {(post.data.author || "O")[0].toUpperCase()}
                  </div>
                  <span>{post.data.author || "OpenShip Team"}</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        {pages.length === 0 && (
          <p className="res-empty">{copy("No posts found in this category yet.")}</p>
        )}
      </main>
    </>
  );
}
