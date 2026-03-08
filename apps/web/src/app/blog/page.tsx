import Link from "next/link";
import { blogSource } from "@/lib/source";
import type { Metadata } from "next";

const SITE_URL = "https://openship.org";

function getCategories() {
  const pages = blogSource.getPages();
  const set = new Set<string>();
  pages.forEach((p) => {
    if (p.data?.category) set.add(p.data.category);
  });
  return [
    { name: "All", slug: "all" },
    ...[...set].sort().map((c) => ({ name: c, slug: c.toLowerCase() })),
  ];
}

function formatDate(raw: string): string {
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
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}): Promise<Metadata> {
  const search = await searchParams;
  const category = search?.category;

  const pageTitle =
    category && category !== "all"
      ? `${category.charAt(0).toUpperCase() + category.slice(1)} – Openship Blog`
      : "Blog – Openship";

  const pageDescription =
    category && category !== "all"
      ? `Browse ${category} articles from the Openship team`
      : "Updates, guides, and engineering deep-dives from the Openship team.";

  return {
    title: pageTitle,
    description: pageDescription,
    openGraph: {
      title: pageTitle,
      description: pageDescription,
      url: `${SITE_URL}/blog${category && category !== "all" ? `?category=${category}` : ""}`,
      siteName: "Openship",
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
}

export default async function BlogPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const search = await searchParams;
  const category = search?.category || "all";

  let pages = blogSource.getPages();
  const categories = getCategories();

  if (category !== "all") {
    pages = pages.filter(
      (p) => (p.data?.category?.toLowerCase() || "") === category.toLowerCase()
    );
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
    name: "Openship Blog",
    description: "Updates, guides, and engineering deep-dives from the Openship team",
    url: `${SITE_URL}/blog`,
    publisher: {
      "@type": "Organization",
      name: "Openship",
    },
    blogPost: pages.slice(0, 10).map((page) => ({
      "@type": "BlogPosting",
      headline: page.data.title,
      description: page.data.description,
      url: `${SITE_URL}${page.url}`,
      datePublished: page.data.date,
      author: { "@type": "Person", name: page.data.author || "Openship Team" },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogStructuredData) }}
      />

      <main className="mx-auto max-w-5xl px-6 pb-24">
        {/* Hero */}
        <div className="pt-16 pb-10">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
            Blog
          </h1>
          <p className="mt-3 max-w-xl text-[17px] leading-relaxed text-gray-500 dark:text-gray-400">
            Engineering deep-dives, product updates, and guides from the Openship team.
          </p>
        </div>

        {/* Category filters */}
        <div className="flex flex-wrap gap-2 border-b border-gray-100 pb-4 dark:border-gray-800">
          {categories.map((cat) => (
            <Link
              key={cat.slug}
              href={cat.slug === "all" ? "/blog" : `/blog?category=${cat.slug}`}
              className={`rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors ${
                category === cat.slug
                  ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              }`}
              aria-current={category === cat.slug ? "page" : undefined}
            >
              {cat.name}
            </Link>
          ))}
        </div>

        {/* Featured post */}
        {featured && (
          <Link
            href={featured.url}
            className="group mt-10 block rounded-2xl border border-gray-100 bg-white p-8 shadow-sm transition-all hover:border-gray-200 hover:shadow-md dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-700 sm:p-10"
          >
            <span className="inline-block rounded-full bg-violet-100 px-3 py-1 text-[12px] font-semibold text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
              {featured.data.category || "Post"}
            </span>
            <h2 className="mt-4 text-2xl font-bold tracking-tight text-gray-900 group-hover:text-gray-700 dark:text-gray-50 dark:group-hover:text-gray-200 sm:text-3xl">
              {featured.data.title}
            </h2>
            {featured.data.description && (
              <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-gray-500 dark:text-gray-400">
                {featured.data.description}
              </p>
            )}
            <div className="mt-5 flex items-center gap-3 text-[13px] text-gray-400 dark:text-gray-500">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-[11px] font-bold text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                {(featured.data.author || "O")[0].toUpperCase()}
              </div>
              <span className="font-medium text-gray-600 dark:text-gray-300">
                {featured.data.author || "Openship Team"}
              </span>
              <span className="text-gray-300 dark:text-gray-600">&middot;</span>
              {featured.data.date && (
                <time dateTime={featured.data.date}>
                  {formatDate(featured.data.date)}
                </time>
              )}
            </div>
          </Link>
        )}

        {/* Card grid */}
        {rest.length > 0 && (
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((post) => (
              <Link
                key={post.url}
                href={post.url}
                className="group flex flex-col rounded-2xl border border-gray-100 bg-white p-6 shadow-sm transition-all hover:border-gray-200 hover:shadow-md dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-700"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-block rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    {post.data.category || "Post"}
                  </span>
                  {post.data.date && (
                    <time
                      className="text-[12px] text-gray-400 dark:text-gray-500"
                      dateTime={post.data.date}
                    >
                      {formatDate(post.data.date)}
                    </time>
                  )}
                </div>
                <h3 className="mt-4 text-lg font-semibold tracking-tight text-gray-900 group-hover:text-gray-700 dark:text-gray-50 dark:group-hover:text-gray-200">
                  {post.data.title}
                </h3>
                {post.data.description && (
                  <p className="mt-2 flex-1 text-[14px] leading-relaxed text-gray-500 dark:text-gray-400">
                    {post.data.description}
                  </p>
                )}
                <div className="mt-4 flex items-center gap-2 text-[12px] text-gray-400 dark:text-gray-500">
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    {(post.data.author || "O")[0].toUpperCase()}
                  </div>
                  <span>{post.data.author || "Openship Team"}</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        {pages.length === 0 && (
          <p className="py-20 text-center text-[15px] text-gray-400 dark:text-gray-500">
            No posts found in this category.
          </p>
        )}
      </main>
    </>
  );
}
