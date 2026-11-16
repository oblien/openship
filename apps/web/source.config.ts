import { defineDocs, defineConfig, frontmatterSchema } from "fumadocs-mdx/config";
import { z } from "zod";
import { remarkSearchCards } from "./src/lib/docs-search";

export const docs = defineDocs({
  dir: "content/docs",
  docs: { postprocess: { includeProcessedMarkdown: true } },
});

export const resources = defineDocs({
  dir: "content/resources",
  docs: {
    schema: frontmatterSchema.extend({
      date: z.string().optional(),
      category: z.string().optional(),
      author: z.string().optional(),
    }),
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkSearchCards],
    rehypeCodeOptions: {
      themes: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" },
    },
  },
});
