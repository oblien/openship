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
 * `configFields` are the operator-facing inputs the Create-App form renders;
 * each maps to a service env key. Fields with `generate:"secret"` are filled
 * with a strong random value by the instantiator (operators never type them);
 * fields sharing a `generateGroup` get the SAME generated value (e.g. a DB
 * password that must match across two services). Secret fields are written
 * through the per-service encrypted-env path, never stored as plaintext here.
 */

import type { ComposeHealthcheck } from "./types";
import type { AppManagement, AppSettingGroup } from "./app-settings";
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
  /** Env keys the operator/instantiator must fill in (secrets) — not stored as defaults. */
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
 * A command run INSIDE a service's container after the first successful deploy,
 * whose stdout is captured and persisted as a service env var. For values the
 * app can only mint itself once it's running (e.g. Convex's admin key, derived
 * in-container from INSTANCE_SECRET+INSTANCE_NAME). Advisory: a failure never
 * fails the deploy. Commands MUST be re-run-safe (may run again on redeploy).
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
}

/** One value surfaced on the app's Connection card for the user to copy. */
export interface AppOutput {
  id: string;
  label: string;
  help?: string;
  /** `env:<service>:<KEY>` (a stored env value) or `publicUrl:<service>[:<port>]`. */
  source: string;
  /** Render masked with a reveal toggle (a credential) vs a plain copyable value. */
  secret?: boolean;
}

/** Post-install connection details (URLs, generated keys) shown to the user. */
export interface AppConnection {
  title?: string;
  description?: string;
  outputs: readonly AppOutput[];
}

/**
 * A thing this app exposes that the install wizard asks the user how to ship.
 * `http` endpoints are web UIs / APIs that route through a domain (free/custom)
 * or run port-only; `tcp` endpoints are raw ports (a database) that can't be
 * domain-routed — the user publishes the port (firewall) or keeps it internal,
 * and in desktop mode can forward it to localhost. Declared per template; when a
 * template omits `endpoints`, one `http` endpoint is derived per exposed service.
 */
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
}

export interface AppTemplate {
  id: string;
  /** Installable now (true) vs a dimmed "coming soon" placeholder (false/omitted). Drives AVAILABLE_APP_IDS. */
  available?: boolean;
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

/**
 * Exposable endpoints for the install wizard. Uses the template's explicit
 * `endpoints` when present; otherwise derives one `http` endpoint per exposed
 * service (its primary route/exposedPort) so single-web-UI apps (Convex, n8n, …)
 * get the same one-picker flow they had before, with no per-template metadata.
 */
export function getAppEndpoints(template: AppTemplate): readonly AppEndpoint[] {
  if (template.endpoints && template.endpoints.length > 0) return template.endpoints;
  const derived: AppEndpoint[] = [];
  for (const svc of template.services ?? []) {
    if (!svc.exposed) continue;
    const port = svc.exposedPort ?? svc.routes?.[0]?.port;
    if (port === undefined) continue;
    derived.push({ service: svc.name, port, label: svc.name, kind: "http" });
  }
  return derived;
}
