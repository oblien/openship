import { getAppEndpoints, resolveInternalEndpoint, type AppTemplate } from "@repo/core";

/**
 * Rewrite a connection URL's host to the source app's internal service alias
 * (`mongodb://root:…@mongo:27017/`) so a consumer on the shared docker network
 * reaches it with no public port.
 *
 * SERVICE-AWARE (authoritative): when the output declares its `service`, rewrite
 * host→that service's alias and port→the service's declared endpoint port. This
 * works even for a PORTLESS url (e.g. a public Kong URL with no `:8000`) — the
 * declared endpoint supplies the port — and it's correct when two services share
 * a port.
 *
 * `declaredPort` (the container port named by a `publicUrl:<svc>:<port>` source)
 * OUTRANKS the resolved URL's own port, because neither resolved shape names the
 * container: a routed value is portless (`https://<host>`), and a published-port
 * value carries the HOST port of the mapping (`19000` of `19000:9000`). Falling
 * back to the service's FIRST declared endpoint in either case handed out the
 * wrong one — MinIO's console (9001) instead of its S3 API (9000).
 *
 * FALLBACK (no declared service): match the port to a declared endpoint and
 * rewrite to that service's alias, as before. A portless URL with no service is
 * not an internal target → null (caller steers to Public). Pure — unit-testable.
 */
export function toInternalUrl(
  value: string,
  template: AppTemplate | undefined,
  service?: string | null,
  declaredPort?: number | null,
): string | null {
  if (!template) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const port = declaredPort ?? (u.port ? Number(u.port) : undefined);

  if (service) {
    const ep = resolveInternalEndpoint(template, service, port);
    if (!ep) return null; // Declared service exposes no endpoint → not internally reachable.
    const kind = getAppEndpoints(template).find(
      (e) => e.service === ep.service && e.port === ep.port,
    )?.kind;
    return rewriteToAlias(u, ep.service, ep.port, kind);
  }

  if (port === undefined) return null;
  const ep = getAppEndpoints(template).find((e) => e.port === port);
  if (!ep) return null;
  return rewriteToAlias(u, ep.service, ep.port, ep.kind);
}

/**
 * Point `u` at `service:port`, dropping TLS for an `http` endpoint: east-west
 * traffic terminates at the container, which serves PLAINTEXT — the edge owns the
 * certificate. Carrying a routed value's `https://` onto the alias produced a URL
 * that can never connect (`https://minio:9000`), and it looked right.
 */
function rewriteToAlias(u: URL, service: string, port: number, kind?: "http" | "tcp"): string {
  if (kind === "http" && u.protocol === "https:") u.protocol = "http:";
  u.hostname = service;
  u.port = String(port);
  return u.href;
}

/**
 * Does `value` name a network location (a parseable URL WITH a host)? Only such a
 * value has a host to rewrite for internal mode; a credential (JWT, password,
 * token, bucket name) carries no host and must be injected verbatim.
 */
export function isNetworkUrl(value: string): boolean {
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}
