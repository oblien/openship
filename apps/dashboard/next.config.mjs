import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same-origin (self-hosted) build: the public host serves the dashboard and the
// API is reached through the /api/proxy forwarder. OAuth 2.1 / MCP clients,
// though, expect the API's discovery + endpoints at CLEAN origin paths. These
// rewrites expose them there (forwarding to the same /api/proxy handler) so a
// remote client's OAuth flow — discovery → authorize → token — resolves against
// the public origin instead of localhost. Only added in proxy builds; cloud/dev
// (NEXT_PUBLIC_API_PROXY unset) get no rewrites and are unchanged.
const API_PROXY = process.env.NEXT_PUBLIC_API_PROXY === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Monorepo: trace from the repo root so the standalone bundle includes the
  // root-hoisted node_modules + workspace packages. Without this, `output:
  // "standalone"` traces from apps/dashboard and can ship an incomplete bundle
  // that fails at runtime with "cannot find module".
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  transpilePackages: ["@repo/ui", "@repo/core", "@repo/db"],
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  async rewrites() {
    if (!API_PROXY) return [];
    return {
      beforeFiles: [
        {
          source: "/.well-known/oauth-authorization-server",
          destination: "/api/proxy/.well-known/oauth-authorization-server",
        },
        {
          source: "/.well-known/oauth-protected-resource",
          destination: "/api/proxy/.well-known/oauth-protected-resource",
        },
        { source: "/api/auth/:path*", destination: "/api/proxy/api/auth/:path*" },
        { source: "/api/mcp", destination: "/api/proxy/api/mcp" },
      ],
    };
  },
};

export default nextConfig;
