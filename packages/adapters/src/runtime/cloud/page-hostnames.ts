import type { PageData } from "oblien";

/** The route registry uses numeric page IDs; Pages operations require slugs.
 * Resolve through the Page's authoritative hostnames, never reinterpret an ID. */
export function cloudPageHostnames(page: Pick<PageData, "slug" | "domain" | "url" | "custom_domain">): string[] {
  const hosts = new Set<string>();
  if (page.slug && page.domain) hosts.add(`${page.slug}.${page.domain}`.toLowerCase());
  if (page.custom_domain) hosts.add(page.custom_domain.toLowerCase());
  try { if (page.url) hosts.add(new URL(page.url).hostname.toLowerCase()); } catch { /* No usable URL in this provider response. */ }
  return [...hosts];
}
