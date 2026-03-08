import { blogSource } from "@/lib/source";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import BlogShareSidebar from "@/components/blog/share-sidebar";
import BlogWriterSidebar from "@/components/blog/writer-sidebar";

const SITE_URL = "https://openship.org";

type Params = Promise<{ slug: string[] }>;

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

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const page = blogSource.getPage(slug);
  if (!page) return {};

  const title = `${page.data.title} – Openship Blog`;
  const description = page.data.description ?? "A blog post from the Openship team.";

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

export default async function BlogPostPage({ params }: { params: Params }) {
  const { slug } = await params;
  const page = blogSource.getPage(slug);
  if (!page) notFound();

  const MDXContent = page.data.body;
  const readingTime = calculateReadingTime(
    (page.data as any)._exports?.raw || page.data.title || ""
  );

  /* Related posts (same category, excluding current) */
  const allPages = blogSource.getPages();
  const related = allPages
    .filter(
      (p) =>
        p.url !== page.url &&
        p.data.category?.toLowerCase() === page.data.category?.toLowerCase()
    )
    .sort((a, b) => (b.data.date ?? "").localeCompare(a.data.date ?? ""))
    .slice(0, 3);

  /* Structured data */
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
      { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog` },
      {
        "@type": "ListItem",
        position: 3,
        name: page.data.title,
        item: `${SITE_URL}${page.url}`,
      },
    ],
  };

  return (
    <div className="blog-post">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleStructuredData) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbStructuredData) }}
      />

      <div className="blog-post-inner">
        <div className="bp-body-wrap">
          {/* ── LEFT: Share actions ── */}
          <div className="bp-left-col">
            <BlogShareSidebar />
          </div>

          {/* ── CENTER: Article ── */}
          <div className="bp-center-col">
            <div className="bp-header">
              <Link href="/blog" className="bp-back">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
                All posts
              </Link>

              <header>
                {page.data.category && (
                  <span className="bp-category">{page.data.category}</span>
                )}
                <h1 className="bp-title">{page.data.title}</h1>
                {page.data.description && (
                  <p className="bp-desc">{page.data.description}</p>
                )}
                <div className="bp-meta">
                  <div className="bp-meta-avatar">
                    {(page.data.author || "O")[0].toUpperCase()}
                  </div>
                  <div className="bp-meta-text">
                    <span className="bp-author-name">
                      {page.data.author || "Openship Team"}
                    </span>
                    <span className="bp-meta-row">
                      {page.data.date && (
                        <time dateTime={page.data.date}>
                          {formatDate(page.data.date)}
                        </time>
                      )}
                      <span className="bp-dot" />
                      <span>{readingTime} min read</span>
                    </span>
                  </div>
                </div>
              </header>
            </div>

            {/* Article body */}
            <div className="bp-body">
              <MDXContent />
            </div>
          </div>

          {/* ── RIGHT: Writer info ── */}
          <div className="bp-right-col">
            <BlogWriterSidebar authorName={page.data.author} />
          </div>
        </div>

        {/* Related articles */}
        {related.length > 0 && (
          <section className="bp-related">
            <span className="bp-related-label">Related articles</span>
            <div className="bp-related-grid">
              {related.map((post) => (
                <Link key={post.url} href={post.url} className="bp-related-card">
                  <span className="bp-related-cat">
                    {post.data.category || "Post"}
                  </span>
                  <h4 className="bp-related-title">{post.data.title}</h4>
                  {post.data.description && (
                    <p className="bp-related-desc">{post.data.description}</p>
                  )}
                  <div className="bp-related-foot">
                    <div className="bp-related-foot-avatar">
                      {(post.data.author || "O")[0].toUpperCase()}
                    </div>
                    <span className="bp-related-author">
                      {post.data.author || "Openship Team"}
                    </span>
                    {post.data.date && (
                      <>
                        <span className="bp-related-dot" />
                        <time className="bp-related-date">
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
  return blogSource.generateParams();
}
