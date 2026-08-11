/**
 * Shared service routing helpers used by both the dashboard and API.
 */

/**
 * Catalog-app templates can declare env values referencing another service's
 * assigned public URL — e.g. `CONVEX_CLOUD_ORIGIN: "{{publicUrl:backend}}"`, or a
 * specific port with `{{publicUrl:backend:3211}}` (Convex serves the API on 3210
 * and HTTP actions on 3211, each under its own domain). The URL is only known
 * once routes are assigned at deploy time, so the compose deploy resolves these
 * placeholders per (service, port) via `resolvePublicUrlPlaceholders`.
 */
const PUBLIC_URL_PLACEHOLDER = /\{\{\s*publicUrl:([a-zA-Z0-9_.-]+?)(?::(\d+))?\s*\}\}/g;

/** Replace `{{publicUrl:<service>}}` / `{{publicUrl:<service>:<port>}}` tokens in
 *  an env map with the resolved public URL for that service (and port, when
 *  given). A token with no port resolves to the service's primary route.
 *  Unknown services/ports resolve to an empty string (the value simply blanks
 *  rather than shipping a literal placeholder). */
export function resolvePublicUrlPlaceholders(
  env: Record<string, string>,
  urlForService: (serviceName: string, port?: number) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] =
      typeof value === "string"
        ? value.replace(PUBLIC_URL_PLACEHOLDER, (_m, name, port) =>
            urlForService(name, port ? Number(port) : undefined) ?? "",
          )
        : value;
  }
  return out;
}

/** Normalize any input into a valid DNS subdomain label. */
export function normalizeServiceLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "service";
}

/**
 * Longest label the free `<slug>.opsh.io` namespace accepts. The cloud rejects
 * anything longer with `invalid_slug` ("Slug must be 1-48 chars"), so a
 * generated label past this never routes — and at ~63+ chars it also fails
 * nginx's `server_names_hash` on the box's own edge.
 */
export const MAX_SERVICE_LABEL_LENGTH = 48;

/**
 * Deterministic short suffix, so a truncated label stays unique AND stable
 * across deploys — a random one would mint a new hostname every time.
 */
function labelHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

/**
 * Clamp a GENERATED label to what the free-subdomain namespace accepts,
 * keeping a hash of the full value so two long labels sharing a prefix don't
 * collide. Applied only to defaults: an explicit subdomain the operator typed
 * is left exactly as written, so it fails loudly instead of silently becoming
 * a different hostname than the one they asked for.
 */
function clampServiceLabel(label: string): string {
  if (label.length <= MAX_SERVICE_LABEL_LENGTH) return label;
  const suffix = `-${labelHash(label)}`;
  const head = label.slice(0, MAX_SERVICE_LABEL_LENGTH - suffix.length).replace(/-+$/, "");
  return `${head}${suffix}`;
}

/**
 * Generate the default hostname label for a service.
 *
 * For compose services, "frontend-style" names ("web", "app", "frontend")
 * collapse to the bare project label - there's a strong implicit "main app"
 * in compose deploys and the UX expects "the web container" to live at
 * the project's base URL.
 *
 * For monorepo sub-apps that convention is wrong: every sub-app is a peer
 * and there's no implicit primary. Two monorepo apps named "web" + "admin"
 * would both have to live at distinct hostnames, so we always namespace.
 * Pass `kind="monorepo"` to opt out of the shortlist collapse.
 */
export function defaultServiceHostnameLabel(
  projectLabel: string,
  serviceName: string,
  kind: "compose" | "monorepo" = "compose",
): string {
  const base = normalizeServiceLabel(projectLabel);
  const normalizedService = normalizeServiceLabel(serviceName);

  if (kind === "compose" && ["web", "app", "frontend"].includes(normalizedService)) {
    return base;
  }

  return `${base}-${normalizedService}`;
}

/**
 * The first CONTAINER-side port from a compose-style ports list. Handles
 * "8080", "3000:3000", "127.0.0.1:80:80", "5432/tcp" — always returns the port
 * the process listens on inside the service, which is what a sibling connects
 * to. Mirrors `firstContainerPort` in the cloud compose adapter.
 */
export function firstServicePort(ports: readonly string[] | undefined): number | undefined {
  for (const spec of ports ?? []) {
    const clean = spec.trim();
    if (!clean) continue;
    const parts = clean.split(":");
    const raw = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
    const match = raw?.match(/^(\d+)(?:\/(?:tcp|udp))?$/i);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/**
 * How ANOTHER service reaches this one on the internal network:
 * `<service-name>:<port>`. The service NAME is the hostname (docker network
 * alias / cloud `/etc/hosts` entry) — NOT the normalized public subdomain — so
 * this is the exact string a sibling puts in `DATABASE_URL`, etc. Falls back to
 * the bare name when no port is known.
 */
export function internalServiceAddress(
  serviceName: string,
  ports: readonly string[] | undefined,
): string {
  const port = firstServicePort(ports);
  return port ? `${serviceName}:${port}` : serviceName;
}

/** Build the public hostname label for a service, preferring the explicit saved subdomain when present. */
export function resolveServiceHostnameLabel(
  projectLabel: string,
  serviceName: string,
  explicitSubdomain?: string | null,
  kind: "compose" | "monorepo" = "compose",
): string {
  // Explicit subdomains pass through unclamped — see clampServiceLabel.
  if (explicitSubdomain) return normalizeServiceLabel(explicitSubdomain);
  return clampServiceLabel(
    normalizeServiceLabel(defaultServiceHostnameLabel(projectLabel, serviceName, kind)),
  );
}