import path from "path";
import { fileURLToPath } from "url";
import { createMDX } from "fumadocs-mdx/next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const withMDX = createMDX({ configPath: "./source.config.ts" });

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Monorepo: trace from the repo root so the standalone bundle includes the
  // root-hoisted node_modules + workspace packages. Without this, `output:
  // "standalone"` traces from apps/web and can ship an incomplete bundle that
  // fails at runtime with "cannot find module".
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  transpilePackages: ["@repo/ui", "@repo/core"],
  async redirects() {
    const movedDocs = [
      ["/docs/api/sdk/reference", "/docs/api"],
      ["/docs/api/sdk/deployments", "/docs/api/deployments"],
    ];
    return movedDocs.flatMap(([source, destination]) => [
      { source, destination, permanent: true },
      { source: `${source}.md`, destination: `${destination}.md`, permanent: true },
    ]);
  },
  // Serve each doc as raw markdown at `/docs/<slug>.md` (llms.txt convention) —
  // rewritten to the `docs-raw` route handler, which emits text/markdown.
  async rewrites() {
    return [
      { source: "/docs.md", destination: "/docs-raw" },
      { source: "/docs/:slug*.md", destination: "/docs-raw/:slug*" },
    ];
  },
  turbopack: {
    root: path.resolve(__dirname, "../.."),
    resolveAlias: {
      "@/.source/*": "./.source/*",
    },
  },
};

export default withMDX(nextConfig);
