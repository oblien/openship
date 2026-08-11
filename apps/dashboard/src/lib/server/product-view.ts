import { cookies, headers } from "next/headers";
import {
  PRODUCT_VIEW_COOKIE,
  PRODUCT_VIEW_HEADER,
  resolveProductView,
  type ProductView,
} from "@/lib/product-view";
import { getDeploymentInfoOrNull, type DeploymentInfo } from "@/lib/server/session";

/**
 * The per-user product view for THIS request, resolved server-side so the very
 * first painted rail and brand name are already correct — reading the cookie
 * client-side would render the platform shell and then swap the whole nav after
 * hydration.
 *
 * Pass `info` when the caller already has deployment info in hand (the dashboard
 * layout fetches it with `skipCache`); otherwise the cached copy is used, and a
 * null one (API down) falls back to the cookie alone.
 */
export async function resolveRequestProductView(
  info?: DeploymentInfo | null,
): Promise<ProductView> {
  // Header first: the proxy (src/proxy.ts) mirrors the cookie onto it because
  // cookies() can come back empty in the SSR render path — the same reason the
  // locale cookie is mirrored (see resolveRequestLocale in app/layout.tsx).
  const [hdrs, cookieStore] = await Promise.all([headers(), cookies()]);
  const cookie =
    hdrs.get(PRODUCT_VIEW_HEADER) ?? cookieStore.get(PRODUCT_VIEW_COOKIE)?.value;

  const resolved = info === undefined ? await getDeploymentInfoOrNull() : info;

  return resolveProductView({
    cookie,
    instanceMode: resolved?.productMode,
    // Unknown deploy shape (API unreachable) → honour the cookie. It was written
    // against a real answer, and pinning the API-down screen to platform branding
    // on a mail box would be a worse guess than trusting the user's own choice.
    selfHosted: resolved?.selfHosted ?? true,
  });
}
