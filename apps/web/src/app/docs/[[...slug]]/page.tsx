import { docsSource } from "@/lib/source";
import { DocsPage, DocsBody } from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

const SITE_URL = "https://openship.org";

type Params = Promise<{ slug?: string[] }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (!page) return {};

  const title = `${page.data.title} – Openship Docs`;
  const description = page.data.description ?? "Openship documentation";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${SITE_URL}${page.url}`,
      siteName: "Openship",
      type: "article",
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

export default async function Page({ params }: { params: Params }) {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (!page) notFound();

  const MDXContent = page.data.body;

  return (
    <DocsPage
      toc={page.data.toc}
      tableOfContent={{
        style: "clerk",
        single: false,
      }}
    >
      <DocsBody>
        <h1 className="text-3xl font-bold tracking-tight">{page.data.title}</h1>
        {page.data.description && (
          <p className="mt-2 text-lg text-fd-muted-foreground">{page.data.description}</p>
        )}
        <MDXContent />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return docsSource.generateParams();
}
