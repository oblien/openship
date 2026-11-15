import { docs, resources } from "@/.source/server";
import type { MDXComponents } from "mdx/types";
import { loader } from "fumadocs-core/source";
import { APP_LOCALES } from "@repo/core/locale";

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export const blogSource = loader({
  baseUrl: "/blog",
  i18n: { defaultLanguage: "en", languages: [...APP_LOCALES] },
  source: resources.toFumadocsSource(),
});

export interface BlogFrontmatter {
  title: string;
  description?: string;
  date?: string;
  category?: string;
  author?: string;
  body: React.ComponentType<{ components?: MDXComponents }>;
  getText: (type: "raw" | "processed") => Promise<string>;
  _exports?: { raw?: string };
}

export interface DocFrontmatter {
  title: string;
  description?: string;
  body: React.ComponentType<{ components?: MDXComponents }>;
  toc: unknown;
}
