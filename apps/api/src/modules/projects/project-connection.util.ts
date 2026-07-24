import { getAppEndpoints, type AppTemplate } from "@repo/core";

/**
 * Rewrite a connection URL's host to the source app's internal service alias
 * (`mongodb://root:…@mongo:27017/`) so a consumer on the shared network reaches
 * it with no public port. Only a URL whose port matches a declared endpoint is
 * rewritten to that service's alias — a portless URL (a domain / Studio link)
 * isn't an internal target and returns null (the caller steers to Public). Pure
 * (no service deps) so it's unit-testable in isolation.
 */
export function toInternalUrl(value: string, template: AppTemplate | undefined): string | null {
  if (!template) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const port = u.port ? Number(u.port) : undefined;
  if (port === undefined) return null;
  const ep = getAppEndpoints(template).find((e) => e.port === port);
  if (!ep) return null;
  u.hostname = ep.service;
  u.port = String(ep.port);
  return u.href;
}
