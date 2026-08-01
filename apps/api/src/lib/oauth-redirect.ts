/**
 * Return the registered redirect URI when the requested URI is an equivalent
 * loopback address. OAuth normally compares redirect URIs exactly, but native
 * MCP clients commonly alternate between localhost and 127.0.0.1 for the same
 * callback listener.
 *
 * This deliberately only aliases loopback hostnames and requires every other
 * URL component to match. Public redirect URIs remain exact-match only.
 */
export function findEquivalentLoopbackRedirectUri(
  requestedUri: string,
  registeredUris: readonly string[],
): string | undefined {
  const exact = registeredUris.find((uri) => uri === requestedUri);
  if (exact) return exact;

  const requested = parseRedirectUri(requestedUri);
  if (!requested || !isLoopbackHostname(requested.hostname)) return undefined;

  return registeredUris.find((registeredUri) => {
    const registered = parseRedirectUri(registeredUri);
    if (!registered || !isLoopbackHostname(registered.hostname)) return false;

    return (
      registered.protocol === requested.protocol &&
      registered.port === requested.port &&
      registered.username === requested.username &&
      registered.password === requested.password &&
      registered.pathname === requested.pathname &&
      registered.search === requested.search &&
      registered.hash === requested.hash
    );
  });
}

export type RegisteredRedirectUriResolver = (
  clientId: string,
) => Promise<readonly string[] | undefined>;

/**
 * Rewrite an MCP authorize/token request to the registered loopback URI before
 * it reaches an OAuth implementation that requires exact redirect_uri equality.
 */
export async function normalizeMcpRedirectUri(
  request: Request,
  resolveRegisteredUris: RegisteredRedirectUriResolver,
): Promise<Request> {
  const url = new URL(request.url);
  const isAuthorize = request.method === "GET" && url.pathname.endsWith("/mcp/authorize");
  const isToken = request.method === "POST" && url.pathname.endsWith("/mcp/token");

  if (!isAuthorize && !isToken) return request;

  let clientId: string | undefined;
  let redirectUri: string | undefined;

  if (isAuthorize) {
    clientId = url.searchParams.get("client_id") ?? undefined;
    redirectUri = url.searchParams.get("redirect_uri") ?? undefined;
  } else {
    const contentType = request.headers.get("content-type") ?? "";
    try {
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const body = await request.clone().formData();
        clientId = stringFormValue(body.get("client_id"));
        redirectUri = stringFormValue(body.get("redirect_uri"));
      } else if (contentType.includes("application/json")) {
        const body = (await request.clone().json()) as Record<string, unknown> | null;
        if (body && typeof body === "object") {
          clientId = stringFormValue(body.client_id);
          redirectUri = stringFormValue(body.redirect_uri);
        }
      }
    } catch {
      // Preserve Better Auth's existing validation response for malformed token
      // requests instead of failing inside this compatibility shim.
      return request;
    }
  }

  if (!clientId || !redirectUri) return request;

  const registeredUris = await resolveRegisteredUris(clientId);
  if (!registeredUris) return request;

  const canonicalUri = findEquivalentLoopbackRedirectUri(redirectUri, registeredUris);
  if (!canonicalUri || canonicalUri === redirectUri) return request;

  if (isAuthorize) {
    url.searchParams.set("redirect_uri", canonicalUri);
    return new Request(url, request);
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const contentType = headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await request.clone().formData();
    body.set("redirect_uri", canonicalUri);
    const encoded = new URLSearchParams();
    body.forEach((value, key) => {
      if (typeof value === "string") encoded.append(key, value);
    });
    return new Request(request, { body: encoded, headers });
  }

  const body = (await request.clone().json()) as Record<string, unknown>;
  return new Request(request, {
    body: JSON.stringify({ ...body, redirect_uri: canonicalUri }),
    headers,
  });
}

function parseRedirectUri(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function stringFormValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
