/** Registry credentials belong to the configured origin, not an arbitrary
 * WWW-Authenticate realm. The two public registries below intentionally use a
 * separate authentication origin; custom registries can serve auth on-origin. */
const DELEGATED_AUTH = new Map([
  ["https://registry-1.docker.io", "https://auth.docker.io"],
  ["https://registry.gitlab.com", "https://gitlab.com"],
]);

export function trustedRegistryRealm(registryUrl: string, realm: string): URL {
  const registry = new URL(registryUrl);
  const target = new URL(realm);
  if (target.username || target.password ||
      (target.protocol !== "https:" && target.protocol !== "http:") ||
      (target.origin !== registry.origin && target.origin !== DELEGATED_AUTH.get(registry.origin))) {
    throw new Error("Registry authentication must use the registry origin or a supported authentication provider.");
  }
  return target;
}

/** A Distribution token response can use either the registry or OAuth field name. */
export function readRegistryToken(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // The response may contain credentials. Treat invalid JSON as a missing token.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { token, access_token } = parsed as { token?: unknown; access_token?: unknown };
  for (const candidate of [token, access_token]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}
