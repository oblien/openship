import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  transpilePackages: ["@repo/ui", "@repo/core", "@repo/db"],
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
};

export default nextConfig;
