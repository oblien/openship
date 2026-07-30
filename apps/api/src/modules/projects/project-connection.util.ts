import { getAppEndpoints, resolveInternalEndpoint, type AppTemplate } from "@repo/core";

/**
 * Rewrite a connection URL's host to the source app's internal service alias
 * (`mongodb://root:…@mongo:27017/`) so a consumer on the shared docker network
 * reaches it with no public port.
 *
 * SERVICE-AWARE (authoritative): when the output declares its `service`, rewrite
 * host→that service's alias and port→the service's declared endpoint port
 * (preferring the endpoint whose port matches the URL's own). This works even
 * for a PORTLESS url (e.g. a public Kong URL with no `:8000`) — the declared
 * endpoint supplies the port — and it's correct when two services share a port.
 *
 * FALLBACK (no declared service): match the URL's port to a declared endpoint and
 * rewrite to that service's alias, as before. A portless URL with no service is
 * not an internal target → null (caller steers to Public). Pure — unit-testable.
 */
export function toInternalUrl(
  value: string,
  template: AppTemplate | undefined,
  service?: string | null,
): string | null {
  if (!template) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const urlPort = u.port ? Number(u.port) : undefined;

  if (service) {
    const ep = resolveInternalEndpoint(template, service, urlPort);
    if (ep) {
      u.hostname = ep.service;
      u.port = String(ep.port);
      return u.href;
    }
    // Declared service exposes no endpoint → not internally reachable.
    return null;
  }

  if (urlPort === undefined) return null;
  const ep = getAppEndpoints(template).find((e) => e.port === urlPort);
  if (!ep) return null;
  u.hostname = ep.service;
  u.port = String(ep.port);
  return u.href;
}
