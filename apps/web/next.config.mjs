import path from "path";
import { fileURLToPath } from "url";
import { createMDX } from "fumadocs-mdx/next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const withMDX = createMDX({ configPath: "./source.config.ts" });

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@repo/ui", "@repo/core"],
  turbopack: {
    root: path.resolve(__dirname, "../.."),
    resolveAlias: {
      "@/.source/*": "./.source/*",
    },
  },
};

export default withMDX(nextConfig);
