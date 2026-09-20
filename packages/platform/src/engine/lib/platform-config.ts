import type { PlatformConfig } from "@repo/adapters";
import { env } from "../config/env";
import { isOblienConfigured } from "./platform-mode";
import { resolveAcmeProviderOptions } from "./acme-config";
import { join } from "node:path";
export { getPlatform as platform } from "@repo/adapters";

// ─── Platform resolution ─────────────────────────────────────────────────────

/**
 * Resolve the deployment target from environment config.
 *
 * CLOUD_MODE (SaaS hosting) and DEPLOY_MODE=cloud (Oblien runtime) both
 * need the cloud platform adapter, so either triggers the cloud config.
 * Auth/billing concerns are gated separately by CLOUD_MODE alone.
 *
 * Priority:
 *   1. CLOUD_MODE=true or DEPLOY_MODE=cloud → "cloud" (Oblien runtime)
 *   2. DEPLOY_MODE=desktop → "desktop"
 *   3. Default → "selfhosted" with docker or bare runtime
 */
export function resolvePlatformConfig(): PlatformConfig {
  if (process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ROUTING === "none") {
    // Reuse the bare/no-routing adapter without adopting Electron's authentication posture.
    return { target: "desktop", bare: { workDir: join(process.env.OPENSHIP_DATA_DIR!, "workloads") } };
  }
  if (isOblienConfigured()) {
    return {
      target: "cloud",
      cloudClientId: env.OBLIEN_CLIENT_ID,
      cloudClientSecret: env.OBLIEN_CLIENT_SECRET,
      cloudApiUrl: env.OBLIEN_API_URL,
      allowHostBuild: !env.CLOUD_MODE && (process.env.OPENSHIP_NATIVE !== "true" || process.env.OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION === "true"),
    };
  }

  if (env.DEPLOY_MODE === "desktop") {
    return { target: "desktop" };
  }

  // Self-hosted: docker or bare
  return {
    target: "selfhosted",
    runtime: env.DEPLOY_MODE === "bare" ? "bare" : "docker",
    nginx: resolveAcmeProviderOptions(),
    ...(process.env.OPENSHIP_NATIVE === "true" && { bare: { workDir: join(process.env.OPENSHIP_DATA_DIR!, "workloads") } }),
  };
}
