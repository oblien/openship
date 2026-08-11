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

/** One `{{publicUrl:…}}` token and what it asks for. */
export interface PublicUrlPlaceholder {
  /** The literal token, e.g. `{{publicUrl:backend:3210}}`. */
  token: string;
  service: string;
  /** Container port; absent for a bare token (the service's primary route). */
  port?: number;
}

/** Every `{{publicUrl:…}}` token in a string, in order (empty when none). */
export function findPublicUrlPlaceholders(value: string): PublicUrlPlaceholder[] {
  const found: PublicUrlPlaceholder[] = [];
  for (const match of value.matchAll(PUBLIC_URL_PLACEHOLDER)) {
    found.push({
      token: match[0],
      service: match[1],
      ...(match[2] ? { port: Number(match[2]) } : {}),
    });
  }
  return found;
}

/**
 * Resolve every `{{publicUrl:…}}` token in ONE string, REPORTING the ones that
 * had no URL. Total by construction: a token either becomes a real URL or is
 * named in `unresolved` — it is never handed back verbatim, so a raw placeholder
 * can't be persisted, injected into a container, or shown to a user (the app
 * Overview once rendered a literal `{{publicUrl:backend:3210}}` as the
 * deployment URL, because the value was passed through unresolved).
 *
 * An unresolved token is dropped from the returned string; a caller that can't
 * ship a partial value (a URL missing its origin) blanks the whole value off
 * `unresolved.length` instead of displaying the remainder.
 */
export function resolvePublicUrlTemplate(
  value: string,
  urlForService: (serviceName: string, port?: number) => string | undefined,
): { value: string; unresolved: PublicUrlPlaceholder[] } {
  const unresolved: PublicUrlPlaceholder[] = [];
  const resolved = value.replace(PUBLIC_URL_PLACEHOLDER, (token, name, port) => {
    const parsedPort = port ? Number(port) : undefined;
    const url = urlForService(name, parsedPort);
    if (url) return url;
    unresolved.push({
      token,
      service: name,
      ...(parsedPort !== undefined ? { port: parsedPort } : {}),
    });
    return "";
  });
  return { value: resolved, unresolved };
}

/** Replace `{{publicUrl:<service>}}` / `{{publicUrl:<service>:<port>}}` tokens in
 *  an env map with the resolved public URL for that service (and port, when
 *  given). A token with no port resolves to the service's primary route.
 *  Unknown services/ports resolve to an empty string (the value simply blanks
 *  rather than shipping a literal placeholder). Token-local on purpose: the same
 *  substitution runs over generated CONFIG FILE contents, where dropping one
 *  unresolved token must not blank the whole file. Callers that need to know
 *  a token went unresolved use `resolvePublicUrlTemplate`. */
export function resolvePublicUrlPlaceholders(
  env: Record<string, string>,
  urlForService: (serviceName: string, port?: number) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] =
      typeof value === "string" ? resolvePublicUrlTemplate(value, urlForService).value : value;
  }
  return out;
}

/**
 * Any `{{…}}` token still present AFTER resolution. A surviving placeholder is
 * not a value: it must never be displayed, copied, or injected into another
 * project's env. Last-line guard for every surface that ships a resolved
 * template value — it also catches grammars this module doesn't own
 * (`{{config:…}}`, `{{env:…}}`, `{{host}}`) and ones a custom catalog overlay
 * invents.
 */
export function hasUnresolvedPlaceholder(value: string | null | undefined): boolean {
  return !!value && /\{\{[^{}]*\}\}/.test(value);
}

/** One service's inputs to `buildPublicUrlLookup`. */
export interface ServicePublicUrlInput {
  /** Service name (docker alias) — the `{{publicUrl:<service>}}` key. */
  name: string;
  /** PERSISTED route URLs keyed by CONTAINER port, primary route first. */
  routedUrls?: ReadonlyMap<number, string>;
  /** Fixed `host:container` port mappings the service publishes. */
  portPairs?: readonly { host: number; container: number }[];
  /** Container port the service treats as primary (`exposedPort`). */
  primaryPort?: number;
}

/**
 * `{{publicUrl:…}}` lookup for a set of services, keyed `<name>` (primary route)
 * and `<name>:<port>` for each container AND published host port.
 *
 * Exactly two sources, in order: a PERSISTED route (a hostname a human chose,
 * read from the project's domain rows) and the honest `http://<host>:<hostPort>`
 * a published port is actually reachable on. A service with neither is ABSENT
 * from the map, so its tokens resolve to nothing and the caller reports them
 * unresolved. A hostname is never derived from the project slug here: an app with
 * no route has no URL, and minting `<label>.<cloudDomain>` for it advertises a
 * host that resolves nowhere.
 */
export function buildPublicUrlLookup(
  services: readonly ServicePublicUrlInput[],
  host?: string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  const put = (key: string, url: string) => {
    if (!out.has(key)) out.set(key, url);
  };

  for (const svc of services) {
    const routed = svc.routedUrls ?? new Map<number, string>();
    for (const [port, url] of routed) put(`${svc.name}:${port}`, url);

    const pairs = svc.portPairs ?? [];
    if (host) {
      for (const pair of pairs) {
        const url = `http://${host}:${pair.host}`;
        put(`${svc.name}:${pair.container}`, url);
        put(`${svc.name}:${pair.host}`, url);
      }
    }

    const primary =
      (svc.primaryPort !== undefined ? out.get(`${svc.name}:${svc.primaryPort}`) : undefined) ??
      routed.values().next().value ??
      (host && pairs[0] ? `http://${host}:${pairs[0].host}` : undefined);
    if (primary) put(svc.name, primary);
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
 * Strict variant for a USER-CHOSEN east-west alias: normalize, but return null
 * when the input carries no usable DNS characters (so an all-symbol/empty entry
 * is rejected rather than silently becoming the `"service"` fallback that
 * `normalizeServiceLabel` hands back). Shared by the single-app project alias
 * and the compose `service.advanced.alias` validators so both reject the same
 * inputs. Length-capped to a legal DNS label.
 */
export function normalizeAliasStrict(value: string | null | undefined): string | null {
  if (!value) return null;
  const alias = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!alias) return null;
  return alias.slice(0, MAX_SERVICE_LABEL_LENGTH);
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
 * Fixed `host:container` port mappings a service publishes — what makes it
 * reachable at `http://<host>:<hostPort>` with no domain. A container-only spec
 * ("3000") gets a random host port we can't know up front, so it's skipped. Both
 * sides are kept: a `{{publicUrl:svc:3000}}` token names the CONTAINER port while
 * the reachable URL carries the HOST one.
 *
 * The ONE parser feeding `buildPublicUrlLookup`, shared by the deploy and the
 * app-settings path so their `portPairs` maps stay keyed identically — a fix here
 * can't miss one copy.
 */
export function servicePortPairs(
  ports: readonly string[] | null | undefined,
): { host: number; container: number }[] {
  const out: { host: number; container: number }[] = [];
  for (const spec of ports ?? []) {
    const parts = String(spec).split(":");
    if (parts.length < 2) continue;
    const host = Number(parts[parts.length - 2]);
    const container = Number(String(parts[parts.length - 1]).replace(/\/(?:tcp|udp)$/i, ""));
    if (Number.isFinite(host) && Number.isFinite(container)) out.push({ host, container });
  }
  return out;
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

/**
 * The hostname a sibling ACTUALLY resolves this service at: the operator's
 * custom alias when set (already DNS-normalized on write via
 * `validateServiceAlias`), else the bare name/label. This is the primary Docker
 * network alias (`buildNetworkAliases(primary, …)`) — service name for compose /
 * monorepo, project slug for a single-app — so displaying the custom alias here
 * matches what embedded DNS answers. One helper shared by the connection
 * synthesizer, the Services list, and the Network card so all three agree.
 */
export function effectiveServiceAlias(
  fallback: string,
  customAlias?: string | null,
): string {
  return normalizeAliasStrict(customAlias) ?? fallback;
}

/**
 * True when `candidate` (an already-normalized DNS label) would collide with any
 * hostname a sibling already answers to on the same project network. A container
 * answers to BOTH its primary alias (its normalized name) AND its custom alias
 * (`buildNetworkAliases(primary, extras)`), so BOTH are in the taken set — the
 * check is symmetric: a new/renamed NAME is rejected against sibling aliases and a
 * new ALIAS against sibling names. `projectInternalAlias` (single-app east-west
 * hostname) is folded in too when supplied, so a service can't shadow it and
 * vice-versa. Embedded DNS is first-match, so a duplicate resolves ambiguously —
 * we reject instead. Pure over its inputs so the rule is testable without a repo.
 */
export function aliasConflictsWithSiblings(
  candidate: string,
  siblings: readonly { name: string; advanced?: unknown }[],
  projectInternalAlias?: string | null,
): boolean {
  for (const s of siblings) {
    if (normalizeServiceLabel(s.name) === candidate) return true;
    const other = (s.advanced as { alias?: string | null } | null)?.alias;
    if (other && normalizeAliasStrict(other) === candidate) return true;
  }
  const ia = normalizeAliasStrict(projectInternalAlias);
  return ia != null && ia === candidate;
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