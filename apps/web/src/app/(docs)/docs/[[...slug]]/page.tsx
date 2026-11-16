import { docsSource } from "@/lib/source";
import { SITE_URL } from "@/lib/sitemap-builder";
import { getMDXComponents } from "@/mdx-components";
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from "fumadocs-ui/layouts/notebook/page";
import { CopyPage } from "@/components/docs/copy-page";
import { Icon } from "@repo/ui/icons";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ComponentType } from "react";
import type { MDXComponents } from "mdx/types";
import type { Metadata } from "next";

type PageProps = { params: Promise<{ slug?: string[] }> };

// The loader's base PageData type doesn't statically expose the MDX body/toc,
// so narrow it to the doc shape (toc type derived from DocsPage itself).
type DocData = {
  title: string;
  description?: string;
  full?: boolean;
  body: ComponentType<{ components?: MDXComponents }>;
  toc: Parameters<typeof DocsPage>[0]["toc"];
};

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (!page) notFound();

  const data = page.data as DocData;
  const MDX = data.body;
  const markdownUrl = `${page.url}.md`;
  const sourceUrl = `https://github.com/oblien/openship/edit/main/apps/web/content/docs/${page.path}`;
  const isHome = !slug?.length;

  return (
    <DocsPage
      toc={data.toc}
      full={data.full}
      className={`docs-article${data.full ? " docs-overview" : ""}${isHome ? " docs-home" : ""}`}
      breadcrumb={{ enabled: !isHome }}
      tableOfContentPopover={{ enabled: !data.full && (data.toc?.length ?? 0) > 0 }}
      footer={{ enabled: !data.full, className: "docs-pagination" }}
      tableOfContent={{ style: "clerk" }}
    >
      <header className="docs-article-header">
        <div className="docs-heading-copy">
          <DocsTitle>{data.title}</DocsTitle>
          <DocsDescription>{data.description}</DocsDescription>
          {isHome && (
            <div className="docs-hero-actions">
              <Link
                href="/docs/getting-started/quickstart"
                className="th-btn"
                data-docs-button="primary"
              >
                Quickstart <Icon name="arrow-right" size={16} aria-hidden="true" />
              </Link>
              <Link href="/docs/getting-started/core-concepts" data-docs-button="secondary">
                Core concepts <Icon name="arrow-right" size={16} aria-hidden="true" />
              </Link>
            </div>
          )}
          {!data.full && (
            <div className="docs-page-actions" aria-label="Page resources">
              <CopyPage key={page.url} markdownUrl={markdownUrl} />
              <a href={markdownUrl}>
                <Icon name="file-text" size={14} aria-hidden="true" /> View Markdown
              </a>
            </div>
          )}
        </div>
      </header>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
      <div className="docs-page-feedback">
        <span>Help improve this page</span>
        <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
          <Icon name="edit" size={14} aria-hidden="true" /> Edit on GitHub
        </a>
        <a
          href="https://github.com/oblien/openship/issues"
          target="_blank"
          rel="noopener noreferrer"
        >
          Report an issue <Icon name="arrow-up-right" size={14} aria-hidden="true" />
        </a>
      </div>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return docsSource.generateParams();
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (!page) notFound();

  const data = page.data as DocData;
  const title = `${data.title} – OpenShip Docs`;
  const description = data.description;

  // Per-page social card. Served by /docs-og (a route handler, since an image
  // segment can't nest under this optional catch-all) and pre-rendered at build.
  const ogImage = {
    url: `${SITE_URL}/docs-og${slug?.length ? `/${slug.join("/")}` : ""}`,
    width: 1200,
    height: 630,
    alt: title,
  };

  return {
    title: { absolute: title },
    description,
    openGraph: {
      title,
      description,
      url: page.url,
      siteName: "OpenShip",
      type: "article",
      images: [ogImage],
    },
    twitter: { card: "summary_large_image", title, description, images: [ogImage] },
    // Advertise the raw-markdown variant (llms.txt convention) alongside canonical.
    alternates: {
      canonical: page.url,
      types: { "text/markdown": `${SITE_URL}${page.url}.md` },
    },
  };
}
