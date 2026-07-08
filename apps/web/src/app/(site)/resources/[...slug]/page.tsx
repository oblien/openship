import { resourcesSource, type ResourceFrontmatter } from "@/lib/source";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import ResourceShareSidebar from "@/components/resources/share-sidebar";
import ResourceWriterSidebar from "@/components/resources/writer-sidebar";

const SITE_URL = "https://openship.io";

type Params = Promise<{ slug: string[] }>;
type RPage = { url: string; data: ResourceFrontmatter };

function calculateReadingTime(content: string): number {
  return Math.max(1, Math.ceil(content.split(/\s+/).length / 200));
}

function formatDate(raw: string): string {
  try {
    return new Date(raw).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return raw;
  }
}

function formatDateShort(raw: string): string {
  try {
    return new Date(raw).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return raw;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { slug } = await params;
  const rawPage = resourcesSource.getPage(slug);
  if (!rawPage) return {};
  const page = rawPage as unknown as RPage;

  const title = `${page.data.title} – Openship Resources`;
  const description =
    page.data.description ?? "A resource article from the Openship team.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${SITE_URL}${page.url}`,
      siteName: "Openship",
      type: "article",
      publishedTime: page.data.date,
      authors: [page.data.author || "Openship Team"],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    alternates: {
      canonical: `${SITE_URL}${page.url}`,
    },
  };
}

export default async function ResourcePostPage({ params }: { params: Params }) {
  const { slug } = await params;
  const rawPage = resourcesSource.getPage(slug);
  if (!rawPage) notFound();
  const page = rawPage as unknown as RPage;

  const MDXContent = page.data.body;
  const readingTime = calculateReadingTime(
    page.data._exports?.raw || page.data.title || ""
  );

  const allPages = resourcesSource.getPages() as unknown as RPage[];
  const related = allPages
    .filter(
      (p) =>
        p.url !== page.url &&
        p.data.category?.toLowerCase() === page.data.category?.toLowerCase()
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
      name: page.data.author || "Openship Team",
    },
    publisher: {
      "@type": "Organization",
      name: "Openship",
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${SITE_URL}${page.url}`,
    },
    articleSection: page.data.category,
    url: `${SITE_URL}${page.url}`,
  };

  const breadcrumbStructuredData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      {
        "@type": "ListItem",
        position: 2,
        name: "Resources",
        item: `${SITE_URL}/resources`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: page.data.title,
        item: `${SITE_URL}${page.url}`,
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
            <Link href="/resources" className="rp-back">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              All resources
            </Link>

            <header>
              {page.data.category && (
                <span className="rp-category">{page.data.category}</span>
              )}
              <h1 className="rp-title">{page.data.title}</h1>
              {page.data.description && (
                <p className="rp-desc">{page.data.description}</p>
              )}
              <div className="rp-meta">
                <div className="rp-meta-avatar" aria-hidden="true">
                  {(page.data.author || "O")[0].toUpperCase()}
                </div>
                <div className="rp-meta-text">
                  <span className="rp-author-name">
                    {page.data.author || "Openship Team"}
                  </span>
                  <span className="rp-meta-row">
                    {page.data.date && (
                      <time dateTime={page.data.date}>
                        {formatDate(page.data.date)}
                      </time>
                    )}
                    <span className="rp-dot" aria-hidden="true" />
                    <span>{readingTime} min read</span>
                  </span>
                </div>
              </div>
            </header>

            <article className="rp-body">
              <MDXContent />
            </article>
          </div>

          <div className="rp-right-col">
            <ResourceWriterSidebar authorName={page.data.author} />
          </div>
        </div>

        {related.length > 0 && (
          <section className="rp-related">
            <span className="rp-related-label">Related articles</span>
            <div className="rp-related-grid">
              {related.map((post) => (
                <Link key={post.url} href={post.url} className="rp-related-card">
                  <span className="rp-related-cat">
                    {post.data.category || "Post"}
                  </span>
                  <h4 className="rp-related-title">{post.data.title}</h4>
                  {post.data.description && (
                    <p className="rp-related-desc">{post.data.description}</p>
                  )}
                  <div className="rp-related-foot">
                    <div className="rp-related-foot-avatar" aria-hidden="true">
                      {(post.data.author || "O")[0].toUpperCase()}
                    </div>
                    <span>{post.data.author || "Openship Team"}</span>
                    {post.data.date && (
                      <>
                        <span className="rp-related-dot" aria-hidden="true" />
                        <time dateTime={post.data.date}>
                          {formatDateShort(post.data.date)}
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

export function generateStaticParams() {
  return resourcesSource.generateParams();
}
