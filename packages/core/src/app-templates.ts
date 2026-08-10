/**
 * Curated Apps catalog.
 *
 * An "App" is a one-click install surfaced in the dashboard's Apps tab. Two kinds:
 *
 *   - "template": a fixed set of upstream images wired together (a backend + its
 *     database, a CMS + its DB, …). These deploy through the compose/services
 *     path — the instantiator creates a repo-less `services` project (marked
 *     `isApp`), seeds the service rows below, and deploys. The runtime handles
 *     service discovery (each service is reachable by name on the project
 *     network) and volume namespacing.
 *   - "flow": an app whose provisioning already has a bespoke wizard (mail /
 *     iRedMail). The catalog entry just points at that flow (`flowHref`); it does
 *     NOT instantiate services here.
 *
 * Two field systems, split by ROLE (don't mix them up):
 *   - `configFields` (AppConfigField) = MACHINE-generated / derived env. Fields
 *     with `generate:"secret"|"jwt"` are filled by the instantiator (operators
 *     never type them); a shared `generateGroup` yields the SAME value across
 *     services (e.g. a DB password that must match). Secret/`secret:true` fields
 *     (and any key listed in a service's `secretEnv`) are written through the
 *     per-service encrypted-env path, never stored as plaintext here.
 *   - `settings` (AppSettingField) with `installStep:true` = the HUMAN-facing
 *     inputs the install wizard renders (text/select/number/…, validated). These
 *     — not `configFields` — are what the operator fills in the Create-App form.
 */

import type { ComposeHealthcheck } from "./types";
import type { AppManagement, AppSettingGroup } from "./app-settings";
import { resolveServiceHostnameLabel } from "./service-routing";
import catalog from "./apps/catalog.json";

export type AppCategory =
  | "backend"
  | "database"
  | "cms"
  | "mail"
  | "analytics"
  | "automation"
  | "other";

export interface TemplateServiceSpec {
  /** Service name — also its hostname/alias on the project network. */
  name: string;
  /** Upstream image (image-only services skip build/clone). */
  image: string;
  /** Port mappings, compose syntax (e.g. "8080:80"). */
  ports?: readonly string[];
  /** Container port to publish publicly (routing target / primary route). */
  exposedPort?: number;
  /**
   * Extra public routes beyond `exposedPort` — a multi-port service (e.g. Convex's
   * API on 3210 + HTTP actions on 3211) publishes one route per port, each under
   * its own subdomain. `slugSuffix` disambiguates the secondary hostname
   * (`<app>-<service>-<suffix>`). Omit for single-route services.
   */
  routes?: readonly {
    port: number;
    slugSuffix?: string;
  }[];
  /** Non-secret environment defaults. */
  environment?: Readonly<Record<string, string>>;
  /** Env keys on this service that are SECRETS: stored encrypted, never written
   *  as plaintext compose env. A key listed here is forced-secret whether its
   *  value comes from `environment` or a `configField`. */
  secretEnv?: readonly string[];
  /** Named volumes / bind mounts (compose syntax). Named volumes are project-scoped. */
  volumes?: readonly string[];
  /** Services that must be running first (deploy ordering). */
  dependsOn?: readonly string[];
  /** Publish this service on a public route. */
  exposed?: boolean;
  /** Container healthcheck (maps to `service.advanced.healthcheck`). */
  healthcheck?: ComposeHealthcheck;
  /** Restart policy (compose syntax). */
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  /** Override the container command. */
  command?: string;
}

export interface AppConfigField {
  /** Env key this value maps to. */
  key: string;
  /** Service whose env this writes to. */
  service: string;
  label: string;
  help?: string;
  type?: "text" | "password";
  /** Prefilled default. */
  default?: string;
  /** Auto-generate a value the operator never types:
   *  - "secret" → a strong random hex string.
   *  - "jwt"    → an HS256 JWT signed with the JWT secret of `jwtSecretGroup`,
   *              carrying `jwtRole` (Supabase anon / service_role keys). */
  generate?: "secret" | "jwt";
  /** Fields sharing a group get the SAME generated value (cross-service match). */
  generateGroup?: string;
  /** For generate:"jwt" — the `generateGroup` of the secret to sign with. */
  jwtSecretGroup?: string;
  /** For generate:"jwt" — the `role` claim (e.g. "anon", "service_role"). */
  jwtRole?: string;
  required?: boolean;
  /** Write as an encrypted secret (isSecret:true). */
  secret?: boolean;
}

/**
 * A command run INSIDE a service's container around the deploy, whose stdout is
 * captured and persisted as a service env var. For values the app can only mint
 * itself once it's running (e.g. Convex's admin key, derived in-container from
 * INSTANCE_SECRET+INSTANCE_NAME). By default advisory (a failure never fails the
 * deploy); set `mustSucceed` to gate the deploy on it. Commands MUST be
 * re-run-safe (may run again on redeploy). All execution is strictly IN-CONTAINER
 * — never a host shell.
 */
export interface AppPrepareStep {
  /** Service whose container the command runs in. */
  service: string;
  /** Command executed via the runtime's in-container exec (`sh -c <command>`). */
  command: string;
  /** Logical id for the captured value (matches an `AppOutput.id`). */
  capture: string;
  /** Regex whose first group is extracted from stdout; whole trimmed stdout when
   *  omitted. E.g. Convex prints `Admin key: <name>|<hex>`. */
  capturePattern?: string;
  /** Persist the captured value as an env key on `service` (encrypted at rest). */
  persistAs?: { key: string; secret?: boolean };
  /** Skip when the persisted value already exists (default true). */
  once?: boolean;
  /**
   * When the step runs relative to the container lifecycle:
   *  - "post-start" (default): after the container is running — today's behavior.
   *  - "post-ready": after `readiness` passes (a real signal, not a fixed retry).
   *  - "pre-deploy": RESERVED — before the container exists. NOT yet supported by
   *    the engine (needs a one-shot init container); a declared pre-deploy step is
   *    skipped with a logged notice. For DB init today use `files`
   *    (→ /docker-entrypoint-initdb.d) + `dependsOn` + `healthcheck`.
   */
  phase?: "pre-deploy" | "post-start" | "post-ready";
  /** Fail the deploy when this step errors (default false = advisory). */
  mustSucceed?: boolean;
  /** For phase:"post-ready" — gate the command on this in-container check
   *  passing: poll `test` (via `sh -c`) every `interval` ms up to `retries`. */
  readiness?: { test: string; interval?: number; retries?: number };
  /** Authored copy for this step in the install stepper's "app-setup" section.
   *  Purely presentational; absent → a generic label. */
  title?: LocalizedString;
  description?: LocalizedString;
  /** Optional icon hint (lucide name) for the step row. */
  icon?: string;
}

/** An alternative labeled form of an AppOutput's value (e.g. an internal-network
 *  URL vs the public one). Same `source` grammar as AppOutput. */
export interface AppOutputVariant {
  id: string;
  label: LocalizedString;
  /** `env:<service>:<KEY>`, `publicUrl:<service>[:<port>]`, or `template:…`. */
  source: string;
}

/** One value surfaced on the app's Connection card for the user to copy. */
export interface AppOutput {
  id: string;
  label: string;
  help?: string;
  /** `env:<service>:<KEY>` (a stored env value), `publicUrl:<service>[:<port>]`,
   *  or `template:…`. The canonical/default value — also what the "Use in a
   *  project" handover injects. */
  source: string;
  /** Render masked with a reveal toggle (a credential) vs a plain copyable value. */
  secret?: boolean;
  /** Recommended target env-var name when wiring this value into another project
   *  (e.g. dbUrl → "DATABASE_URL"). Authored in the catalog so the "Use in a
   *  project" flow can prefill it instead of guessing client-side. */
  envKey?: string;
  /** Source SERVICE this output belongs to (a `TemplateServiceSpec.name` /
   *  `AppEndpoint.service`, i.e. the docker network alias). Authoritative for
   *  internal-mode host rewriting — needed when the `source` string can't carry
   *  it (a `template:` URL). Falls back to the service parsed from `source`
   *  (`env:<service>:…` / `publicUrl:<service>…`) via `getOutputService`. */
  service?: string;
  /** Part of the one-click recommended bundle — pre-checked in the connection
   *  handover so the user doesn't have to reason about which value to inject. */
  recommended?: boolean;
  /** Label for the PRIMARY `source` in the value switch (default "Default").
   *  Only meaningful alongside `variants` (e.g. "Public"). */
  sourceLabel?: LocalizedString;
  /** Additional labeled forms of the SAME value — the card shows a switch over
   *  `[primary, …variants]` and swaps the shown/copied value. Omit for a single value. */
  variants?: readonly AppOutputVariant[];
  /** Layout hint on the Connection card: two consecutive `half` outputs pair on
   *  one line; `full` (default) spans the row. */
  width?: "full" | "half";
  /** Presentation kind. "url" → the Connection card renders an Open (new tab)
   *  action beside the value. Acted on only for a resolved http(s) URL; default
   *  "text". Additive/optional — does not bump the schema version. */
  kind?: "text" | "url";
}

/**
 * A catalog string that may be a plain value OR an inline per-locale map, so a
 * template (or a user-authored overlay) can localize copy right in the JSON:
 *   "Ready to use"  |  { "en": "Ready to use", "fr": "Prêt à l'emploi" }
 * Resolve with `resolveLocalized(value, locale)`.
 */
export type LocalizedString = string | { [locale: string]: string };

/** Pick the right locale from a LocalizedString (→ exact locale → base lang →
 *  `en` → first available → ""). Plain strings pass through unchanged. */
export function resolveLocalized(
  value: LocalizedString | undefined | null,
  locale?: string,
  fallback = "en",
): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  const base = locale?.split("-")[0];
  return (
    (locale && value[locale]) ||
    (base && value[base]) ||
    value[fallback] ||
    Object.values(value)[0] ||
    ""
  );
}

/**
 * Plain-language handover guidance for wiring this app into ANOTHER project —
 * the "how do I connect this to my app" answer. Rendered by the Use-in-a-project
 * modal, natively. Optional; apps without it fall back to generic copy. All copy
 * fields are `LocalizedString` so a template can ship translations inline.
 */
export interface AppConnectionGuide {
  /** One-liner framing ("Your app gets the connection ready to use."). */
  intro?: LocalizedString;
  /** The copy-ready usage line ("Read `process.env.DATABASE_URL` in your code —
   *  it's set on the next deploy."). */
  useHint?: LocalizedString;
  /** Preselected reachability mode for the handover (default "internal"). */
  defaultMode?: "internal" | "public";
}

/** Static default credentials an app ships with (Grafana admin/admin). FIXED
 *  values, not resolved from a service — so they're their own field, not outputs. */
export interface AppFirstLogin {
  username?: LocalizedString;
  password?: LocalizedString;
  note?: LocalizedString;
}

/** Post-install connection details (URLs, generated keys) shown to the user. */
export interface AppConnection {
  title?: string;
  description?: string;
  outputs: readonly AppOutput[];
  /** Opinionated handover guidance for the "Use in a project" flow. */
  guide?: AppConnectionGuide;
  /** Default credentials to show on the install-done screen. */
  firstLogin?: AppFirstLogin;
}

/**
 * A thing this app exposes that the install wizard asks the user how to ship.
 * `http` endpoints are web UIs / APIs that route through a domain (free/custom)
 * or run port-only; `tcp` endpoints are raw ports (a database) that can't be
 * domain-routed — the user publishes the port (firewall) or keeps it internal.
 * In desktop mode the wizard shows a "reach it on localhost" hint for port-only
 * / internal endpoints (advisory copy — there is no automatic port-forwarding
 * yet). Declared per template; when a template omits `endpoints`, one `http`
 * endpoint is derived per exposed service.
 */
/** An exposure mode a wizard endpoint can take. http: domain|port; tcp: publish|internal. */
export type EndpointMode = "domain" | "port" | "publish" | "internal";

export interface AppEndpoint {
  /** Service the endpoint belongs to (matches a TemplateServiceSpec.name). */
  service: string;
  /** Container port. */
  port: number;
  /** Human label for the wizard/overview ("Studio & API", "Database"). */
  label: string;
  /** `http` = domain-routable web UI/API; `tcp` = raw port (DB) — no domain. */
  kind: "http" | "tcp";
  /** Must be reachable for the app to be usable (default true). */
  required?: boolean;
  /** Declared reachability intent — a DB defaults to internal, a UI to public. */
  scope?: "public" | "internal" | "local";
  /** Pre-selected exposure mode in the install wizard. Else the wizard's own
   *  default: http → domain when Cloud is connected, port otherwise; tcp → publish. */
  defaultMode?: EndpointMode;
  /** Restrict the exposure choices offered (else all valid for the kind). */
  allowedModes?: readonly EndpointMode[];
}

/**
 * A connectable BUNDLE this app advertises to other projects — a named set of
 * connection outputs (by `AppOutput.id`) a consumer can wire in one click.
 */
export interface AppProvides {
  id: string;
  /** `AppOutput.id`s (from `connection.outputs`) this bundle exposes. */
  outputRefs: readonly string[];
  /** Category hint for matching a consumer's `requires`. */
  category?: AppCategory;
}

/**
 * A connection this app NEEDS from another project — drives an install-time
 * picker + one-click auto-wire. Still same-org and still user-confirmed; this
 * only declares the intent so the wizard can offer it instead of manual wiring.
 */
export interface AppRequires {
  id: string;
  label: LocalizedString;
  /** Match candidate source apps by category (e.g. "database"). */
  category?: AppCategory;
  /** Target env var the resolved connection value is injected as. */
  envKey: string;
  /** Reachability mode for the wired connection (default "public"). */
  mode?: "internal" | "public";
  /** A missing optional requirement doesn't block install (default false). */
  optional?: boolean;
}

export interface AppTemplate {
  id: string;
  /** Installable now (true) vs a dimmed "coming soon" placeholder (false/omitted). Drives AVAILABLE_APP_IDS. */
  available?: boolean;
  /** Trust mark shown in the catalog + wizard: an official open-source image,
   *  version-pinned, with a reviewed deployment pipeline. Data-driven so a future
   *  community/unverified app can omit it. */
  verified?: boolean;
  /**
   * Catalog-schema revision this entry was authored against (absent ⇒ 1). A
   * consumer DROPS (keeps last-good) any overlay entry whose `schemaVersion`
   * exceeds `MAX_SUPPORTED_SCHEMA` rather than mis-installing it — the
   * forward-compat gate that lets the shape evolve without breaking old boxes.
   */
  schemaVersion?: number;
  /** Minimum Openship version (semver) required to install this app. Absent ⇒ any. */
  minEngine?: string;
  /** ISO timestamp of the last catalog edit — surface-only ("template updated"). */
  updatedAt?: string;
  /** Public source repository (or homepage) for the underlying project — surfaced as a link in the app's Source tab. */
  repository?: string;
  name: string;
  description: string;
  /** "template" = instantiate the services below; "flow" = defer to `flowHref`. */
  kind: "template" | "flow";
  /** Catalog logo id (resolved to an icon in the dashboard). */
  logo: string;
  category: AppCategory;
  tags?: readonly string[];
  /** Stack id the instantiated project carries (template kind). */
  framework?: string;
  /** Services to seed (template kind). */
  services?: readonly TemplateServiceSpec[];
  /** Operator-facing config inputs the Create-App form renders (template kind). */
  configFields?: readonly AppConfigField[];
  /** Dashboard route to hand off to (flow kind, e.g. "/emails"). */
  flowHref?: string;
  /** Curated day-2 settings surfaced after install (see app-settings.ts). */
  settings?: readonly AppSettingGroup[];
  /**
   * How the installed app is managed. Omit → derived: "schema" when `settings`
   * exist, else none (raw project tabs only). Set explicitly for apps with a
   * bespoke surface (mail → /emails).
   */
  management?: AppManagement;
  /** Commands run post-deploy whose stdout becomes a captured/persisted output. */
  prepare?: readonly AppPrepareStep[];
  /** Connection details (URLs, generated keys) surfaced for the user to copy. */
  connection?: AppConnection;
  /**
   * Exposable endpoints the install wizard asks the user how to ship (per
   * endpoint). Omit → the wizard derives one `http` endpoint per exposed service
   * (single-picker, unchanged behavior). See `getAppEndpoints`.
   */
  endpoints?: readonly AppEndpoint[];
  /**
   * Generated config files bind-mounted (read-only) into a service's container
   * at deploy — for apps that need a config FILE, not just env (e.g. Kong's
   * declarative `kong.yml`, Postgres init `.sql`). `content` may contain the
   * same `{{publicUrl:…}}` and generated-key (`{{config:KEY}}`) placeholders as
   * env, resolved at install. Self-hosted / desktop only (cloud can't bind-mount).
   */
  files?: readonly AppFile[];
  /** Connectable bundles this app advertises to other projects. */
  provides?: readonly AppProvides[];
  /** Connections this app needs from other projects (install-time auto-wire). */
  requires?: readonly AppRequires[];
}

/** A generated file bind-mounted into a service container (see AppTemplate.files). */
export interface AppFile {
  /** Service whose container the file mounts into. */
  service: string;
  /** Absolute container path (the mount target). */
  path: string;
  /** File contents; may contain `{{publicUrl:…}}` / `{{config:KEY}}` placeholders. */
  content: string;
}


/**
 * The bundled app catalog. Source of truth = per-app JSON in `apps/catalog/`,
 * merged into `apps/catalog.json` by `scripts/gen-catalog.ts`. Trusted +
 * generated, so it's imported + cast directly (no reparse). The API overlays a
 * repo-fetched copy on top (shape-validated) so new/updated apps land without a
 * redeploy — see apps/api `catalog-source.ts`.
 */
export const APP_TEMPLATES: readonly AppTemplate[] = catalog.apps as unknown as readonly AppTemplate[];

/**
 * The catalog schema revision this build authors AND understands. Bump ONLY on a
 * BREAKING shape change (a removed/repurposed field); additive fields and new
 * enum members never bump it. Overlay ingest gates against `MAX_SUPPORTED_SCHEMA`
 * (see apps/schema.ts) so a newer-than-known entry degrades gracefully.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export function getAppTemplate(id: string): AppTemplate | undefined {
  return APP_TEMPLATES.find((t) => t.id === id);
}

/**
 * Apps enabled (installable) in THIS version. Everything else in the catalog is
 * still shown — dimmed + "Coming soon", not installable — until it's ready.
 * Single switch: add an id here to light it up (and guard install server-side).
 */
export const AVAILABLE_APP_IDS: ReadonlySet<string> = new Set(
  APP_TEMPLATES.filter((t) => t.available).map((t) => t.id),
);

/** Is this catalog app installable now, or a dimmed "coming soon" placeholder? */
export function isAppAvailable(id: string): boolean {
  return AVAILABLE_APP_IDS.has(id);
}

/** Curated day-2 settings groups for an app (empty when it has none). */
export function getAppSettings(template: AppTemplate): readonly AppSettingGroup[] {
  return template.settings ?? [];
}

/**
 * How an app is managed: an explicit `management`, else "schema" when it
 * declares settings, else null (no curated surface — raw project tabs only).
 */
export function getAppManagement(template: AppTemplate): AppManagement | null {
  if (template.management) return template.management;
  if (template.settings && template.settings.length > 0) return { kind: "schema" };
  return null;
}

/** Post-deploy prepare steps for an app (empty when it has none). */
export function getAppPrepareSteps(template: AppTemplate): readonly AppPrepareStep[] {
  return template.prepare ?? [];
}

/** Connection details to surface after install (null when the app declares none). */
export function getAppConnection(template: AppTemplate): AppConnection | null {
  return template.connection ?? null;
}

/** Static default credentials for the install-done screen (null when none). */
export function getAppFirstLogin(template: AppTemplate): AppFirstLogin | null {
  return template.connection?.firstLogin ?? null;
}

/**
 * Every route a template service DECLARES, primary first — ONE entry per port
 * that can carry a hostname.
 *
 * The single authority for "what routes does this service have", shared by the
 * install wizard's pickers and the installer's routing plan. They used to
 * disagree: the wizard derived one endpoint per SERVICE while the plan walked
 * every declared port, so a secondary route (Convex's 3211 HTTP-actions port)
 * was never shown yet still got a live *.opsh.io hostname minted for it.
 * `exposedPort` is appended when it isn't already a declared route so a
 * service's primary port can never become unaskable.
 */
export function declaredServiceRoutes(
  svc: Pick<TemplateServiceSpec, "routes" | "exposedPort">,
): readonly { port: number; slugSuffix?: string }[] {
  const out: { port: number; slugSuffix?: string }[] = [];
  for (const route of svc.routes ?? []) {
    if (out.some((r) => r.port === route.port)) continue;
    out.push({ port: route.port, slugSuffix: route.slugSuffix });
  }
  if (svc.exposedPort !== undefined && !out.some((r) => r.port === svc.exposedPort)) {
    out.push({ port: svc.exposedPort });
  }
  return out;
}

/**
 * The free-subdomain LABEL an app install defaults to for one declared route.
 *
 * ONE answer, because the wizard PREVIEWS it and the installer PERSISTS it: the
 * wizard used to preview the raw project name (`Convex.opsh.io`) while the
 * installer wrote `convex-backend`, so the hostname the operator was shown was
 * not the hostname they got.
 */
export function defaultAppRouteLabel(
  projectLabel: string,
  serviceName: string,
  slugSuffix?: string,
): string {
  const base = resolveServiceHostnameLabel(projectLabel, serviceName, undefined, "compose");
  return slugSuffix ? `${base}-${slugSuffix}` : base;
}

/**
 * Exposable endpoints for the install wizard. Uses the template's explicit
 * `endpoints` when present; otherwise derives one `http` endpoint per DECLARED
 * ROUTE of every exposed service — one picker per port, so a multi-port service
 * (Convex's 3210 API + 3211 HTTP actions) surfaces both instead of hiding the
 * second behind a server-side default.
 */
export function getAppEndpoints(template: AppTemplate): readonly AppEndpoint[] {
  if (template.endpoints && template.endpoints.length > 0) return template.endpoints;
  const derived: AppEndpoint[] = [];
  for (const svc of template.services ?? []) {
    if (!svc.exposed) continue;
    for (const route of declaredServiceRoutes(svc)) {
      derived.push({
        service: svc.name,
        port: route.port,
        label: route.slugSuffix ? `${svc.name} (${route.slugSuffix})` : svc.name,
        kind: "http",
      });
    }
  }
  return derived;
}

/**
 * The source SERVICE (docker network alias) an output belongs to: the explicit
 * `output.service` when authored, else parsed from the `source` prefix
 * (`env:<service>:…` / `publicUrl:<service>…`). Null for a `template:` source
 * with no declared service — there's no alias to rewrite an internal URL to.
 * Single authority so the DTO, the internal-URL rewrite, and validation agree.
 */
export function getOutputService(output: Pick<AppOutput, "service" | "source">): string | null {
  if (output.service) return output.service;
  const m = /^(?:env|publicUrl):([^:]+)/.exec(output.source ?? "");
  return m?.[1] ?? null;
}

/**
 * Resolve the internal docker endpoint (service alias + container port) an
 * internal connection URL should point at: the declared endpoint for `service`,
 * preferring one whose port matches `preferredPort` (the source URL's own port),
 * else the required endpoint, else the first. Null when the service exposes no
 * declared endpoint. Replaces the old port-coincidence guess — the service is
 * authoritative, so two endpoints sharing a port or a portless URL resolve
 * correctly.
 */
export function resolveInternalEndpoint(
  template: AppTemplate,
  service: string,
  preferredPort?: number,
): { service: string; port: number } | null {
  const eps = getAppEndpoints(template).filter((e) => e.service === service);
  if (eps.length === 0) return null;
  const byPort =
    preferredPort !== undefined ? eps.find((e) => e.port === preferredPort) : undefined;
  const chosen = byPort ?? eps.find((e) => e.required) ?? eps[0]!;
  return { service: chosen.service, port: chosen.port };
}

/** Connectable bundles this app advertises to other projects (empty when none). */
export function getAppProvides(template: AppTemplate): readonly AppProvides[] {
  return template.provides ?? [];
}

/** Connections this app needs from other projects (empty when none). */
export function getAppRequires(template: AppTemplate): readonly AppRequires[] {
  return template.requires ?? [];
}
