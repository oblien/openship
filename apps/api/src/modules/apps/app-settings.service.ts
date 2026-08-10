/**
 * Curated day-2 settings for an installed app.
 *
 * Reads/writes a small, schema-defined set of env keys per service instead of
 * the raw project env editor. Writes go through the SAFE merge path
 * (`mergeEnvVars`) so untouched keys — including generated install secrets like
 * INSTANCE_SECRET / N8N_ENCRYPTION_KEY on the same service — are never wiped.
 * Env changes take effect on the next deploy; the client applies with a restart
 * (or a full redeploy for `requiresRedeploy` fields).
 */

import {
  getAppManagement,
  getAppSettings,
  getAppConnection,
  getOutputService,
  flattenSettingFields,
  validateSetting,
  ValidationError,
  buildPublicUrlLookup,
  servicePortPairs,
  findPublicUrlPlaceholders,
  hasUnresolvedPlaceholder,
  resolvePublicUrlTemplate,
  effectiveServiceAlias,
  normalizeServiceLabel,
  type AppManagement,
  type AppSettingGroup,
  type AppConnectionGuide,
  type ComposeAdvanced,
  type LocalizedString,
} from "@repo/core";
import { isStaticService, parseServicePort, resolveServicePort } from "../../lib/deployable-service";
import { getTemplateForOrg } from "./catalog-source";
import { repos, type Project, type Service } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { encrypt, decrypt } from "../../lib/encryption";
import type { ProjectDomainRow } from "../../lib/public-endpoints";
import { isLoopbackHost, resolveProjectServerHost } from "../../lib/server-target";

const ENVIRONMENT = "production";

export interface AppSettingValue {
  service: string;
  key: string;
  /** Effective override value (decrypted); "" for secrets and unset keys. */
  value: string;
  secret: boolean;
  /** An override row exists for this key (distinguishes "set" from "default"). */
  set: boolean;
}

export interface AppSettingsView {
  appTemplateId: string | null;
  management: AppManagement | null;
  groups: AppSettingGroup[];
  values: AppSettingValue[];
}

export interface AppSettingChange {
  service: string;
  key: string;
  value: string;
}

async function loadAppProject(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  return project;
}

export async function getAppProjectSettings(
  ctx: RequestContext,
  projectId: string,
): Promise<AppSettingsView> {
  const project = await loadAppProject(ctx, projectId);
  const template = project.appTemplateId
    ? await getTemplateForOrg(project.organizationId, project.appTemplateId)
    : undefined;
  const groups = template ? [...getAppSettings(template)] : [];
  const management = template ? getAppManagement(template) : null;

  const fields = flattenSettingFields(groups);
  const services = await repos.service.listByProject(projectId);
  const idByName = new Map(services.map((s) => [s.name, s.id]));

  const values: AppSettingValue[] = [];
  for (const svcName of new Set(fields.map((f) => f.service))) {
    const serviceId = idByName.get(svcName);
    const rows = serviceId ? await repos.project.listEnvVars(projectId, ENVIRONMENT, serviceId) : [];
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const f of fields.filter((x) => x.service === svcName)) {
      const row = byKey.get(f.key);
      values.push({
        service: f.service,
        key: f.key,
        value: row && !f.secret ? decrypt(row.value) : "",
        secret: !!f.secret,
        set: !!row,
      });
    }
  }

  return { appTemplateId: project.appTemplateId ?? null, management, groups, values };
}

export async function updateAppProjectSettings(
  ctx: RequestContext,
  projectId: string,
  changes: AppSettingChange[],
): Promise<{ count: number; requiresRedeploy: boolean }> {
  const project = await loadAppProject(ctx, projectId);
  const template = project.appTemplateId
    ? await getTemplateForOrg(project.organizationId, project.appTemplateId)
    : undefined;
  if (!template) throw new ValidationError("This app has no configurable settings.");

  const fields = flattenSettingFields(getAppSettings(template));
  const fieldOf = (service: string, key: string) =>
    fields.find((f) => f.service === service && f.key === key);

  // Normalize to strings up front. A JSON number/boolean is legitimate input for
  // a number/boolean field, but the schema + crypto layers operate on strings —
  // and encrypt() throws on a non-string, which would surface as a 500.
  const normalized = changes.map((c) => ({
    service: c.service,
    key: c.key,
    value: typeof c.value === "string" ? c.value : c.value == null ? "" : String(c.value),
  }));

  // Validate everything (+ reject unknown keys) before touching storage. Mirror
  // the install-wizard `required` gate for the explicit-empty case (a secret's
  // blank means "leave unchanged", so it's exempt).
  for (const c of normalized) {
    const field = fieldOf(c.service, c.key);
    if (!field) throw new ValidationError(`Unknown setting: ${c.service}.${c.key}`);
    if (field.required && !field.secret && c.value === "") {
      throw new ValidationError(`${field.label} is required.`);
    }
    const err = validateSetting(field, c.value);
    if (err) throw new ValidationError(err);
  }

  const services = await repos.service.listByProject(projectId);
  const idByName = new Map(services.map((s) => [s.name, s.id]));

  // Build the FULL per-service write plan (encrypting as we go) before issuing a
  // single write, so a bad element can't leave a multi-service PATCH half-applied.
  type Plan = { upserts: { key: string; value: string; isSecret: boolean }[]; deletes: string[] };
  const plan = new Map<string, Plan>();
  let count = 0;
  let requiresRedeploy = false;

  for (const c of normalized) {
    const field = fieldOf(c.service, c.key)!;
    const serviceId = idByName.get(c.service);
    if (!serviceId) throw new ValidationError(`Service not found: ${c.service}`);
    const entry = plan.get(serviceId) ?? { upserts: [], deletes: [] };

    if (field.secret) {
      if (c.value === "") continue; // blank secret → leave the stored value unchanged
      entry.upserts.push({ key: field.key, value: encrypt(c.value), isSecret: true });
    } else if (c.value === "") {
      entry.deletes.push(field.key); // clear the override → template default applies
    } else {
      entry.upserts.push({ key: field.key, value: encrypt(c.value), isSecret: false });
    }
    if (field.requiresRedeploy) requiresRedeploy = true;
    count++;
    plan.set(serviceId, entry);
  }

  for (const [serviceId, { upserts, deletes }] of plan) {
    if (upserts.length > 0 || deletes.length > 0) {
      await repos.project.mergeEnvVars(projectId, ENVIRONMENT, upserts, deletes, serviceId);
    }
  }

  return { count, requiresRedeploy };
}

// ─── App connection card (URLs + generated keys, fully resolved) ─────────────

/** One resolved connection value for the app Overview's Connection card. */
export interface AppConnectionOutput {
  id: string;
  label: string;
  help?: string;
  /** Render masked with a reveal toggle. The real value is still sent (this is a
   *  deliberate, template-curated credentials surface for an authorized member). */
  secret: boolean;
  /** Resolved PRIMARY value; "" when it can't be resolved yet (renders as "—"). */
  value: string;
  /** Catalog-recommended target env-var name for the "Use in a project" handover
   *  (so the client doesn't guess). Undefined → the client falls back. */
  envKey?: string;
  /** Source SERVICE (docker alias) this output belongs to — lets the connect UI
   *  group outputs by service and pick which service(s) to inject. Derived from
   *  the output's declared `service` or its `source` prefix; null when neither
   *  carries one (a `template:` value with no service → internal not available). */
  service: string | null;
  /** Part of the recommended one-click bundle — pre-checked in the handover. */
  recommended?: boolean;
  /** Label for the primary value in the switch (default "Default"); with `variants`. */
  sourceLabel?: LocalizedString;
  /** Resolved alternative forms of the value — the card shows a switch over
   *  `[primary, …variants]`. Omitted when the output declares none. */
  variants?: { id: string; label: LocalizedString; value: string }[];
  /** Layout hint: "half" pairs with the next half-width output on one line. */
  width?: "full" | "half";
  /** "url" → the card offers an Open-in-new-tab action for the resolved value. */
  kind?: "text" | "url";
  /** The `value` is ALREADY an internal address (`http://<alias>:<port>`),
   *  synthesized for a project with no template `connection` block. The connect
   *  flow injects it directly for internal mode instead of routing through
   *  `toInternalUrl` (which needs a template we don't have). Undefined/false for
   *  every template-declared output — behaviour there is unchanged. */
  internal?: boolean;
}

export interface AppConnectionView {
  title?: string;
  description?: string;
  outputs: AppConnectionOutput[];
  /** Opinionated handover guidance (localizable) — see AppConnectionGuide. Copy
   *  fields are passed through as-authored (string OR locale-map); the dashboard
   *  resolves them against the active locale via `resolveLocalized`. */
  guide?: AppConnectionGuide;
}

/**
 * Host to reach a no-domain (port-only) service at: the project's OWN server
 * (SSH host / SERVER_IP), and nothing else. Null = unknown, which every caller
 * renders as "—".
 *
 * Loopback counts as unknown (see `isLoopbackHost`): `127.0.0.1` is what the
 * local "This Server" row stores for DISPLAY when no public address was known,
 * and inside a container it is the container itself — so an app handed that
 * origin points at itself.
 *
 * There is deliberately NO fallback to the openship instance's own public URL.
 * On a cloud-target app that is the CONTROL PLANE's hostname, so a routeless app
 * would print `http://api.openship.io:3210` as its deployment URL: a host nobody
 * chose, non-empty enough that the "no URL yet" guards downstream stop firing,
 * and it gets persisted into a second project's env by "Use in a project".
 */
async function resolvePortOnlyHost(project: Project): Promise<string | null> {
  const serverHost = await resolveProjectServerHost(project).catch(() => null);
  return serverHost && !isLoopbackHost(serverHost) ? serverHost : null;
}

/** A domain row's target port, or undefined for a path (static) target. */
function rowTargetPort(row: ProjectDomainRow): number | undefined {
  const port = typeof row.targetPort === "string" ? Number(row.targetPort) : row.targetPort;
  return typeof port === "number" && Number.isFinite(port) && port > 0 && port <= 65535
    ? port
    : undefined;
}

/** Primary row first, then stable by hostname — the primary route owns its port. */
function byPrimaryThenHostname(left: ProjectDomainRow, right: ProjectDomainRow): number {
  if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
  return left.hostname.localeCompare(right.hostname);
}

/**
 * A service's PERSISTED route URLs, keyed by container port. Read from the
 * project's domain rows — a route exists because a human chose it and it was
 * written — never derived from the service's stored routing config, which would
 * mint a `<label>.<cloudDomain>` hostname for a project that has no route at all.
 *
 * The row's `hostname` is used VERBATIM. Re-deriving it (free row → slug →
 * `slug + <current routing base>`) silently dropped every persisted free row whose
 * hostname no longer carries the instance's current routing-base suffix — a box
 * whose routing base changed, or a `.opsh.io` row on a self-hosted base — and the
 * app then reported "no URL" for a hostname that is live on the edge right now.
 *
 * Both scopes count: a service-scoped row is the app's own route, and a
 * project-level row whose target port is one this service publishes is the same
 * route added through the Domains tab (an app is a project wrapper, one pipeline).
 * Redirecting hosts are skipped — they send the visitor elsewhere instead of
 * serving the app, so they're not where it answers.
 */
function persistedServiceRouteUrls(
  service: Service,
  domains: ProjectDomainRow[],
): Map<number, string> {
  const urls = new Map<number, string>();
  const add = (row: ProjectDomainRow) => {
    if (row.redirectTo) return;
    const port = rowTargetPort(row);
    const hostname = row.hostname?.trim().toLowerCase();
    if (port === undefined || !hostname || urls.has(port)) return;
    urls.set(port, `https://${hostname}`);
  };

  const ordered = [...domains].sort(byPrimaryThenHostname);
  for (const row of ordered) {
    if (row.serviceId === service.id) add(row);
  }

  const containerPorts = new Set(
    servicePortPairs(service.ports as string[] | null).map((p) => p.container),
  );
  const exposedPort = parseServicePort(service.exposedPort) ?? undefined;
  if (exposedPort !== undefined) containerPorts.add(exposedPort);
  for (const row of ordered) {
    if (row.serviceId) continue;
    const port = rowTargetPort(row);
    if (port !== undefined && containerPorts.has(port)) add(row);
  }

  return urls;
}

/**
 * Resolve an installed app's Connection card values from the single source of
 * truth: the backing services' env (written once at install, encrypted at rest)
 * + the project's PERSISTED routes. `env:<svc>:<KEY>` reads the stored env
 * (secrets decrypted — this is a curated credentials surface, not the raw env
 * editor); `publicUrl:<svc>[:<port>]` and any `{{publicUrl:…}}` token inside a
 * stored env value resolve to a real domain row, else the reachable
 * `http://<host>:<port>` of a published port, else nothing.
 *
 * Every value shipped here is fully resolved: a placeholder that can't be
 * resolved becomes "" (the card's muted "—"), never a literal `{{…}}`. The card
 * IS the "Use in a project" injection source, so a raw token surviving here
 * would land in another project's container env.
 */
export async function getAppConnectionView(
  ctx: RequestContext,
  projectId: string,
): Promise<AppConnectionView> {
  const project = await loadAppProject(ctx, projectId);
  const template = project.appTemplateId
    ? await getTemplateForOrg(project.organizationId, project.appTemplateId)
    : undefined;
  const connection = template ? getAppConnection(template) : null;
  // A project with no template `connection` block is still internally reachable
  // — every project joins its own docker network with a stable alias. Synthesize
  // an internal-address view so a plain single-app / compose / monorepo project
  // can be a linkable SOURCE ("Use in a project" → internal), not just catalog
  // apps. The curated public/secret surface stays template-only.
  if (!connection) return synthesizeInternalConnectionView(project);

  const services = await repos.service.listByProject(projectId);
  const byName = new Map(services.map((s) => [s.name, s]));

  // Fetch each referenced service's env once, decrypting every value (all rows
  // are encrypt()-ed at rest regardless of the secret flag).
  const needed = new Set<string>();
  const scanSource = (source: string) => {
    const m = /^env:([^:]+):/.exec(source);
    if (m) needed.add(m[1]);
    // template: sources may reference `{{env:<svc>:<KEY>}}` too — fetch those.
    if (source.startsWith("template:")) {
      for (const mm of source.matchAll(/\{\{\s*env:([^:}]+):[^}]+\}\}/g)) needed.add(mm[1]);
    }
  };
  for (const o of connection.outputs) {
    scanSource(o.source);
    for (const v of o.variants ?? []) scanSource(v.source);
  }
  const envByService = new Map<string, Record<string, string>>();
  for (const name of needed) {
    const svc = byName.get(name);
    // Effective env, mirroring the deploy merge: the service's compose env map
    // (JSONB, template literals like ME_CONFIG_BASICAUTH_USERNAME) as the base,
    // overlaid by the env_vars table (generated secrets / config, decrypted).
    // Reading only env_vars missed literals that never became env_var rows.
    const map: Record<string, string> = { ...((svc?.environment as Record<string, string>) ?? {}) };
    const rows = svc ? await repos.project.listEnvVars(projectId, ENVIRONMENT, svc.id) : [];
    for (const row of rows) {
      try {
        map[row.key] = decrypt(row.value);
      } catch {
        map[row.key] = "";
      }
    }
    envByService.set(name, map);
  }

  // Server host for the port-only URL fallback — resolved lazily (only if some
  // source needs a host at all), and shared across every source in this view
  // (primary + variants) so it's fetched at most once.
  let serverHost: string | null | undefined;
  const ensureServerHost = async (): Promise<string | null> => {
    if (serverHost === undefined) serverHost = await resolvePortOnlyHost(project);
    return serverHost;
  };

  // `{{publicUrl:svc[:port]}}` → persisted route URL, else the reachable
  // `http://host:port`. Built once for the whole view (primary + variants), and
  // only when something actually references a public URL — a routeless app needs
  // no domain lookup. Keyed exactly like the deploy's own map so the card and the
  // container env can't disagree about a service's URL.
  let publicUrls: Map<string, string> | undefined;
  const ensurePublicUrls = async (): Promise<Map<string, string>> => {
    if (publicUrls) return publicUrls;
    const domains: ProjectDomainRow[] = await repos.domain
      .listByProject(projectId)
      .catch(() => []);
    publicUrls = buildPublicUrlLookup(
      services.map((svc) => ({
        name: svc.name,
        routedUrls: persistedServiceRouteUrls(svc, domains),
        portPairs: servicePortPairs(svc.ports as string[] | null),
        primaryPort: parseServicePort(svc.exposedPort) ?? undefined,
      })),
      await ensureServerHost(),
    );
    return publicUrls;
  };

  /** Substitute `{{publicUrl:…}}` in a STORED value (a template's service env is
   *  persisted with the token still in it, resolved per-deploy). An unresolvable
   *  token blanks the whole value: a URL missing its origin is a half-truth, and
   *  the literal token must never reach the card. */
  const resolvePublicUrlTokens = async (raw: string): Promise<string> => {
    if (findPublicUrlPlaceholders(raw).length === 0) return raw;
    const lookup = await ensurePublicUrls();
    const { value, unresolved } = resolvePublicUrlTemplate(raw, (name, port) =>
      lookup.get(port !== undefined ? `${name}:${port}` : name),
    );
    return unresolved.length > 0 ? "" : value;
  };

  /** Resolve ONE source string (`env:…` / `template:…` / `publicUrl:…`) → value,
   *  "" when a piece can't resolve. Used for the primary source AND each variant. */
  const resolveSourceValue = async (source: string): Promise<string> => {
    const em = /^env:([^:]+):(.+)$/.exec(source);
    const pm = /^publicUrl:([^:]+)(?::(\d+))?$/.exec(source);
    if (em) return resolvePublicUrlTokens(envByService.get(em[1])?.[em[2]] ?? "");
    if (source.startsWith("template:")) {
      // A composed string (e.g. a `postgresql://…` connection URL): substitute
      // `{{env:<svc>:<KEY>}}` and `{{host}}` (the port-only reachable host).
      // Blank the whole value if any placeholder can't resolve — a URL with a
      // missing password/host is worse than "—".
      let tpl = source.slice("template:".length);
      let ok = true;
      tpl = tpl.replace(/\{\{\s*env:([^:}]+):([^}]+?)\s*\}\}/g, (_m, svc, key) => {
        const v = envByService.get(svc)?.[key] ?? "";
        if (!v) ok = false;
        return v;
      });
      if (tpl.includes("{{host}}")) {
        const host = await ensureServerHost();
        if (!host) ok = false;
        tpl = tpl.replaceAll("{{host}}", host ?? "");
      }
      // A substituted env value can itself carry a `{{publicUrl:…}}` token.
      return ok ? resolvePublicUrlTokens(tpl) : "";
    }
    if (pm) {
      const lookup = await ensurePublicUrls();
      return lookup.get(pm[2] ? `${pm[1]}:${Number(pm[2])}` : pm[1]) ?? "";
    }
    return "";
  };

  /** Last-line guard: a placeholder that survived resolution is not a value.
   *  Blank it so the card renders its muted "—" (not routed yet) instead of a
   *  literal `{{publicUrl:backend:3210}}`, and so the "Use in a project" handover
   *  can't inject a token into another project's env. */
  const resolveSource = async (source: string): Promise<string> => {
    const value = await resolveSourceValue(source);
    return hasUnresolvedPlaceholder(value) ? "" : value;
  };

  const outputs: AppConnectionOutput[] = [];
  for (const o of connection.outputs) {
    const value = await resolveSource(o.source);
    // Resolve variants sequentially so they share the lazily-fetched serverHost
    // (concurrent resolution would race on it — harmless but wasteful).
    let variants: { id: string; label: LocalizedString; value: string }[] | undefined;
    if (o.variants && o.variants.length > 0) {
      variants = [];
      for (const v of o.variants) {
        variants.push({ id: v.id, label: v.label, value: await resolveSource(v.source) });
      }
    }
    outputs.push({
      id: o.id,
      label: o.label,
      help: o.help,
      secret: !!o.secret,
      value,
      envKey: o.envKey,
      service: getOutputService(o),
      recommended: o.recommended,
      sourceLabel: o.sourceLabel,
      variants,
      width: o.width,
      kind: o.kind,
    });
  }

  return {
    title: connection.title,
    description: connection.description,
    outputs,
    guide: connection.guide,
  };
}

/** A stable env-var name derived from a service alias: `api` → `API_URL`,
 *  `my-app` → `MY_APP_URL`. Prefilled in the handover; the user can override. */
function aliasEnvKey(alias: string): string {
  const base = alias.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${base || "SERVICE"}_URL`;
}

/** One internal-address output for a reachable alias. `internal: true` tells the
 *  connect flow the value is already the east-west address (no template rewrite). */
function makeInternalOutput(alias: string, port: number): AppConnectionOutput {
  return {
    id: alias,
    label: alias,
    secret: false,
    value: `http://${alias}:${port}`,
    envKey: aliasEnvKey(alias),
    service: alias,
    internal: true,
    width: "full",
  };
}

/**
 * Connection view for a project with NO template `connection` block — a plain
 * single-app, raw compose, monorepo, or imported project. Each such project
 * still joins its own docker network under a stable alias (single-app via
 * build-pipeline's `networkAlias`, services via their name), so it's internally
 * reachable; this surfaces that as the "Use in a project" source.
 *
 * Only INTERNAL addresses are synthesized (`http://<alias>:<port>`): the alias
 * matches the primary Docker alias each container answers to, and the custom
 * alias (`service.advanced.alias` / `project.internalAlias`) wins when set, so
 * the value equals what embedded DNS resolves. No public/secret values are
 * invented — that curated surface stays template-only. Empty (no port anywhere)
 * → `{ outputs: [] }`, which the card renders as nothing.
 */
async function synthesizeInternalConnectionView(
  project: Project,
): Promise<AppConnectionView> {
  const services = await repos.service.listByProject(project.id);
  const outputs: AppConnectionOutput[] = [];

  if (services.length > 0) {
    // Service-based (compose / monorepo / imported): one output per service that
    // listens on a port. Exposed services first — a sibling most often wants the
    // app, not its sidecar DB — but every reachable service is offered.
    const ordered = [...services].sort((a, b) => Number(!!b.exposed) - Number(!!a.exposed));
    for (const svc of ordered) {
      // A static sub-app (Vite/CRA build served as files off the edge's shared
      // volume) has no listening container, yet persistMonorepoApps still writes
      // it an `exposedPort` from the framework stack default — so resolveServicePort
      // returns a real (bogus) port and the `!port` guard below never fires. Skip
      // it explicitly, mirroring the single-app branch's `productionMode !==
      // "static"` exclusion: `http://<alias>:<port>` would be a dead address.
      if (isStaticService(svc)) continue;
      // No `project.port` fallback here: compose/monorepo deploy publishes each
      // service from its OWN `ports` (never the project port), so a portless
      // sidecar (e.g. a worker) genuinely listens on nothing. Offering
      // `http://<worker>:<projectPort>` would be a dead address — skip it, the
      // same honesty the single-app/static branch keeps below.
      const port = resolveServicePort(svc);
      if (!port) continue;
      const alias = effectiveServiceAlias(svc.name, (svc.advanced as ComposeAdvanced | null)?.alias);
      outputs.push(makeInternalOutput(alias, port));
    }
  } else if (project.hasServer !== false && project.productionMode !== "static") {
    // Single-app native: the project itself is the one reachable endpoint. Alias
    // = custom `internalAlias`, else the slug — exactly build-pipeline's
    // networkAlias. Port from the project row (default 3000, same as deploy).
    // Static projects are skipped: they serve through the edge off a shared
    // volume with no listening container, so `http://alias:port` would be a dead
    // address — better to offer nothing than a URL that never answers.
    const alias = effectiveServiceAlias(
      normalizeServiceLabel(project.slug || project.name),
      project.internalAlias,
    );
    outputs.push(makeInternalOutput(alias, project.port ?? 3000));
  }

  if (outputs.length === 0) return { outputs: [] };
  // defaultMode "internal": these values ARE internal addresses, so the connect
  // modal should land on internal (public would inject the same address for a
  // routeless app, which is harmless but not the point).
  return { outputs, guide: { defaultMode: "internal" } };
}
