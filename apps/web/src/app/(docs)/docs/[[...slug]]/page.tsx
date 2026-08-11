import { docsSource } from "@/lib/source";
import { SITE_URL } from "@/lib/sitemap-builder";
import { getMDXComponents } from "@/mdx-components";
import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from "fumadocs-ui/page";
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

  return (
    <DocsPage toc={data.toc} full={data.full}>
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription>{data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
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
  const title = `${data.title} – Openship Docs`;
  const description = data.description;

  return {
    title,
    description,
    openGraph: { title, description, url: page.url, siteName: "Openship", type: "article" },
    twitter: { card: "summary_large_image", title, description },
    // Advertise the raw-markdown variant (llms.txt convention) alongside canonical.
    alternates: {
      canonical: page.url,
      types: { "text/markdown": `${SITE_URL}${page.url}.md` },
    },
  };
}
