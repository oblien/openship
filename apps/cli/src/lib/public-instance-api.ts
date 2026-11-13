import { SDK_CAPABILITIES } from "@repo/contracts";
import { HttpClient } from "@repo/sdk/client";

/** A public dashboard may mount the API beneath /api/proxy. Probe without
 * credentials and never follow redirects or infer another origin. */
export async function discoverPublicInstanceApi(baseUrl: string): Promise<string | null> {
  const base = new HttpClient({ baseUrl }).apiUrl.slice(0, -4);
  if (/\/(?:api|api\/proxy)$/.test(new URL(baseUrl).pathname.replace(/\/+$/, ""))) return null;
  const candidate = `${base}/api/proxy`;
  try {
    const response = await fetch(`${candidate}/api/health`, {
      headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const health = await response.json() as { status?: string; sdk?: { protocol?: number } };
    return health?.status === "ok" && health.sdk?.protocol === SDK_CAPABILITIES.protocol ? candidate : null;
  } catch {
    return null;
  }
}
