import path from "path";
import { fileURLToPath } from "url";
import { createMDX } from "fumadocs-mdx/next";
import createNextIntlPlugin from "next-intl/plugin";
import marketingPaths from "./src/i18n/paths.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const withMDX = createMDX({ configPath: "./source.config.ts" });
const withIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Multiple document layouts plus a locale segment need an independent 404 document.
  experimental: { globalNotFound: true },
  // Monorepo: trace from the repo root so the standalone bundle includes the
  // root-hoisted node_modules + workspace packages. Without this, `output:
  // "standalone"` traces from apps/web and can ship an incomplete bundle that
  // fails at runtime with "cannot find module".
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  transpilePackages: ["@repo/ui", "@repo/core"],
  async redirects() {
    const movedDocs = [
      ["/docs/api/affiliates", "/docs/api/referrals"],
      ["/docs/guides/affiliates", "/docs/guides/referrals"],
      ["/docs/api/sdk/reference", "/docs/api"],
      ["/docs/api/sdk/deployments", "/docs/api/deployments"],
    ];
    return [
      { source: "/affiliates/:path*", destination: "/referrals/:path*", permanent: true },
      { source: "/og/affiliates.png", destination: "/og/referrals.png", permanent: true },
      { source: "/docs/affiliates/:path*", destination: "/docs/referrals/:path*", permanent: true },
      { source: "/roadmap", destination: "/blog", permanent: true },
      { source: "/resources", destination: "/blog", permanent: true },
      { source: "/resources/:slug*", destination: "/blog/:slug*", permanent: true },
      { source: "/sitemaps/resources.xml", destination: "/sitemaps/blog.xml", permanent: true },
      ...movedDocs.flatMap(([source, destination]) => [
        { source, destination, permanent: true },
        { source: `${source}.md`, destination: `${destination}.md`, permanent: true },
      ]),
    ];
  },
  // Serve each doc as raw markdown at `/docs/<slug>.md` (llms.txt convention) —
  // rewritten to the `docs-raw` route handler, which emits text/markdown.
  async rewrites() {
    const sections = marketingPaths.localized.join("|");
    return {
      beforeFiles: [
        { source: "/docs.md", destination: "/docs-raw" },
        { source: "/docs/:slug*.md", destination: "/docs-raw/:slug*" },
        { source: "/", destination: "/en" },
        { source: `/:section(${sections})/:path*`, destination: "/en/:section/:path*" },
        { source: "/:image(opengraph-image[^/]*|twitter-image[^/]*)", destination: "/en/:image" },
      ],
    };
  },
  turbopack: {
    root: path.resolve(__dirname, "../.."),
    resolveAlias: {
      "@/.source/*": "./.source/*",
    },
  },
};

export default withIntl(withMDX(nextConfig));
