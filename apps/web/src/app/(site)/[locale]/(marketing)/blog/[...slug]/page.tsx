import { localizedHref } from "@/i18n/routing";
import { getLocale } from "next-intl/server";
import { localizedMetadata } from "@/i18n/metadata";

import { getCopy } from "@/i18n/copy-server";
import { reportCaughtError } from "@repo/core/diagnostics";
import { blogSource, type BlogFrontmatter } from "@/lib/source";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/Link";
import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import ResourceShareSidebar from "@/components/resources/share-sidebar";
import ResourceWriterSidebar from "@/components/resources/writer-sidebar";

const SITE_URL = "https://openship.io";

type Params = Promise<{ slug: string[] }>;
type RPage = { url: string; data: BlogFrontmatter };

function calculateReadingTime(content: string): number {
  return Math.max(1, Math.ceil(content.split(/\s+/).length / 200));
}

function formatDate(raw: string, locale: string): string {
  try {
    return new Date(raw).toLocaleDateString(locale, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch (error) {
    reportCaughtError(error, "web/app/(site)/blog/[...slug]/page");
    return raw;
  }
}

function formatDateShort(raw: string, locale: string): string {
  try {
    return new Date(raw).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch (error) {
    reportCaughtError(error, "web/app/(site)/blog/[...slug]/page");
    return raw;
  }
}

export async function generateMetadata(
  { params }: { params: Params },
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const { slug } = await params;
  const locale = await getLocale();
  const rawPage = blogSource.getPage(slug, locale);
  if (!rawPage) return {};
  const page = rawPage as unknown as RPage;

  const title = `${page.data.title} – OpenShip Blog`;
  const description = page.data.description ?? "An article from the OpenShip team.";

  const metadata: Metadata = {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${SITE_URL}${localizedHref(page.url, locale)}`,
      siteName: "OpenShip",
      type: "article",
      publishedTime: page.data.date,
      authors: [page.data.author || "OpenShip Team"],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    alternates: {
      canonical: `${SITE_URL}${localizedHref(page.url, locale)}`,
    },
  };
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default async function BlogPostPage({ params }: { params: Params }) {
  const copy = await getCopy();
  const locale = await getLocale();

  const { slug } = await params;
  const rawPage = blogSource.getPage(slug, locale);
  if (!rawPage) notFound();
  const page = rawPage as unknown as RPage;

  const MDXContent = page.data.body;
  const content = await page.data.getText("raw").catch((error) => {
    reportCaughtError(error, "web/app/(site)/blog/[...slug]/page");
    return page.data.title;
  });
  const readingTime = calculateReadingTime(content);

  const allPages = blogSource.getPages(await getLocale()) as unknown as RPage[];
  const related = allPages
    .filter(
      (p) =>
        p.url !== page.url && p.data.category?.toLowerCase() === page.data.category?.toLowerCase(),
    )
    .sort((a, b) => (b.data.date ?? "").localeCompare(a.data.date ?? ""))
    .slice(0, 3);

  const articleStructuredData = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: page.data.title,
    description: page.data.description,
    datePublished: page.data.date,
    author: {
      "@type": "Person",
      name: page.data.author || "OpenShip Team",
    },
    publisher: {
      "@type": "Organization",
      name: "OpenShip",
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${SITE_URL}${localizedHref(page.url, locale)}`,
    },
    articleSection: page.data.category,
    url: `${SITE_URL}${localizedHref(page.url, locale)}`,
  };

  const breadcrumbStructuredData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: copy("Home"), item: SITE_URL },
      {
        "@type": "ListItem",
        position: 2,
        name: copy("Blog"),
        item: `${SITE_URL}/blog`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: page.data.title,
        item: `${SITE_URL}${localizedHref(page.url, locale)}`,
      },
    ],
  };

  return (
    <div className="res-post">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleStructuredData) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbStructuredData) }}
      />

      <div className="res-post-inner">
        <div className="rp-body-wrap">
          <div className="rp-left-col">
            <ResourceShareSidebar />
          </div>

          <div className="rp-center-col">
            <Link href="/blog" className="rp-back">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              {copy("All posts")}
            </Link>

            <header>
              {page.data.category && (
                <span className="rp-category">{copy(page.data.category)}</span>
              )}
              <h1 className="rp-title">{copy(page.data.title)}</h1>
              {page.data.description && <p className="rp-desc">{copy(page.data.description)}</p>}
              <div className="rp-meta">
                <div className="rp-meta-avatar" aria-hidden="true">
                  {(page.data.author || "O")[0].toUpperCase()}
                </div>
                <div className="rp-meta-text">
                  <span className="rp-author-name">{page.data.author || "OpenShip Team"}</span>
                  <span className="rp-meta-row">
                    {page.data.date && (
                      <time dateTime={page.data.date}>{formatDate(page.data.date, locale)}</time>
                    )}
                    <span className="rp-dot" aria-hidden="true" />
                    <span>
                      {copy(readingTime)} {copy(" min read")}
                    </span>
                  </span>
                </div>
              </div>
            </header>

            <article className="rp-body">
              <MDXContent
                components={{
                  a: ({ href, ...props }) =>
                    href ? <Link href={href} {...props} /> : <a {...props} />,
                }}
              />
            </article>
          </div>

          <div className="rp-right-col">
            <ResourceWriterSidebar authorName={page.data.author} />
          </div>
        </div>

        {related.length > 0 && (
          <section className="rp-related">
            <span className="rp-related-label">{copy("Related articles")}</span>
            <div className="rp-related-grid">
              {related.map((post) => (
                <Link key={post.url} href={post.url} className="rp-related-card">
                  <span className="rp-related-cat">{post.data.category || "Post"}</span>
                  <h4 className="rp-related-title">{copy(post.data.title)}</h4>
                  {post.data.description && (
                    <p className="rp-related-desc">{copy(post.data.description)}</p>
                  )}
                  <div className="rp-related-foot">
                    <div className="rp-related-foot-avatar" aria-hidden="true">
                      {(post.data.author || "O")[0].toUpperCase()}
                    </div>
                    <span>{post.data.author || "OpenShip Team"}</span>
                    {post.data.date && (
                      <>
                        <span className="rp-related-dot" aria-hidden="true" />
                        <time dateTime={post.data.date}>
                          {formatDateShort(post.data.date, locale)}
                        </time>
                      </>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export function generateStaticParams({ params }: { params: { locale: string } }) {
  return blogSource.getPages(params.locale).map((page) => ({ slug: page.slugs }));
}
