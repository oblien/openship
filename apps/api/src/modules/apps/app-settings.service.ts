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
  flattenSettingFields,
  validateSetting,
  ValidationError,
  type AppManagement,
  type AppSettingGroup,
} from "@repo/core";
import { getRuntimeTemplate } from "./catalog-source";
import { repos, type Project, type Service } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { encrypt, decrypt } from "../../lib/encryption";
import { resolveServiceEndpointUrls } from "../../lib/public-endpoints";
import { resolveProjectServerHost } from "../../lib/server-target";
import { resolveDashboardPublicUrl } from "../../lib/public-url";

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
  const template = project.appTemplateId ? getRuntimeTemplate(project.appTemplateId) : undefined;
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
  const template = project.appTemplateId ? getRuntimeTemplate(project.appTemplateId) : undefined;
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

  // Validate everything (+ reject unknown keys) before touching storage.
  for (const c of normalized) {
    const field = fieldOf(c.service, c.key);
    if (!field) throw new ValidationError(`Unknown setting: ${c.service}.${c.key}`);
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
  /** Resolved value; "" when it can't be resolved yet (renders as "—"). */
  value: string;
}

export interface AppConnectionView {
  title?: string;
  description?: string;
  outputs: AppConnectionOutput[];
}

/**
 * Host to reach a no-domain (port-only) service at. Prefers the project's own
 * server (SSH host / SERVER_IP); falls back to the openship instance's own
 * public host (so a same-box install resolves to the address the user already
 * reaches openship on, e.g. localhost in dev). Null only if nothing is known.
 */
async function resolvePortOnlyHost(project: Project): Promise<string | null> {
  const serverHost = await resolveProjectServerHost(project).catch(() => null);
  if (serverHost) return serverHost;
  try {
    return new URL(resolveDashboardPublicUrl()).hostname || null;
  } catch {
    return null;
  }
}

/** Host ports a service publishes via fixed `host:container` mappings (port-only
 *  fallback when there's no domain). Mirrors the deploy's `hostPublishedPorts`. */
function servicePublishedHostPorts(service: Service): number[] {
  const out: number[] = [];
  for (const spec of (service.ports as string[] | null) ?? []) {
    const parts = String(spec).split(":");
    if (parts.length < 2) continue;
    const host = Number(parts[parts.length - 2]);
    if (Number.isFinite(host)) out.push(host);
  }
  return out;
}

/**
 * Resolve an installed app's Connection card values from the single source of
 * truth: the backing services' env (written once at install, encrypted at rest)
 * + the same public-URL resolution the deploy uses. `env:<svc>:<KEY>` reads the
 * stored env (secrets decrypted — this is a curated credentials surface, not the
 * raw env editor); `publicUrl:<svc>[:<port>]` resolves the assigned domain URL,
 * falling back to `http://<host>:<port>` for a no-domain (port-only) install.
 */
export async function getAppConnectionView(
  ctx: RequestContext,
  projectId: string,
): Promise<AppConnectionView> {
  const project = await loadAppProject(ctx, projectId);
  const template = project.appTemplateId ? getRuntimeTemplate(project.appTemplateId) : undefined;
  const connection = template ? getAppConnection(template) : null;
  if (!connection) return { outputs: [] };

  const services = await repos.service.listByProject(projectId);
  const byName = new Map(services.map((s) => [s.name, s]));

  // Fetch each referenced service's env once, decrypting every value (all rows
  // are encrypt()-ed at rest regardless of the secret flag).
  const needed = new Set<string>();
  for (const o of connection.outputs) {
    const m = /^env:([^:]+):/.exec(o.source);
    if (m) needed.add(m[1]);
    // template: sources may reference `{{env:<svc>:<KEY>}}` too — fetch those.
    if (o.source.startsWith("template:")) {
      for (const mm of o.source.matchAll(/\{\{\s*env:([^:}]+):[^}]+\}\}/g)) needed.add(mm[1]);
    }
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

  // Server host for the port-only URL fallback — resolved lazily (only if a
  // publicUrl output has no assigned domain).
  let serverHost: string | null | undefined;

  const outputs: AppConnectionOutput[] = [];
  for (const o of connection.outputs) {
    let value = "";
    const em = /^env:([^:]+):(.+)$/.exec(o.source);
    const pm = /^publicUrl:([^:]+)(?::(\d+))?$/.exec(o.source);
    if (em) {
      value = envByService.get(em[1])?.[em[2]] ?? "";
    } else if (o.source.startsWith("template:")) {
      // A composed string (e.g. a `postgresql://…` connection URL): substitute
      // `{{env:<svc>:<KEY>}}` and `{{host}}` (the port-only reachable host).
      // Blank the whole value if any placeholder can't resolve — a URL with a
      // missing password/host is worse than "—".
      let tpl = o.source.slice("template:".length);
      let ok = true;
      tpl = tpl.replace(/\{\{\s*env:([^:}]+):([^}]+?)\s*\}\}/g, (_m, svc, key) => {
        const v = envByService.get(svc)?.[key] ?? "";
        if (!v) ok = false;
        return v;
      });
      if (tpl.includes("{{host}}")) {
        if (serverHost === undefined) serverHost = await resolvePortOnlyHost(project);
        if (!serverHost) ok = false;
        tpl = tpl.replaceAll("{{host}}", serverHost ?? "");
      }
      value = ok ? tpl : "";
    } else if (pm) {
      const svc = byName.get(pm[1]);
      if (svc) {
        const port = pm[2] ? Number(pm[2]) : undefined;
        const urls = resolveServiceEndpointUrls(project, svc);
        const domainUrl = port !== undefined ? urls.find((u) => u.port === port)?.url : urls[0]?.url;
        if (domainUrl) {
          value = domainUrl;
        } else {
          if (serverHost === undefined) serverHost = await resolvePortOnlyHost(project);
          const hostPorts = servicePublishedHostPorts(svc);
          const chosen = port !== undefined && hostPorts.includes(port) ? port : hostPorts[0];
          if (serverHost && chosen !== undefined) value = `http://${serverHost}:${chosen}`;
        }
      }
    }
    outputs.push({ id: o.id, label: o.label, help: o.help, secret: !!o.secret, value });
  }

  return { title: connection.title, description: connection.description, outputs };
}
