import { defineDocs, defineConfig, frontmatterSchema } from "fumadocs-mdx/config";
import { z } from "zod";

export const docs = defineDocs({ dir: "content/docs" });

export const blog = defineDocs({
  dir: "content/blog",
  docs: {
    schema: frontmatterSchema.extend({
      date: z.string().optional(),
      category: z.string().optional(),
      author: z.string().optional(),
    }),
  },
});

export default defineConfig();
