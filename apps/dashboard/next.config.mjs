/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@repo/ui", "@repo/core", "@repo/db"],
};

export default nextConfig;
