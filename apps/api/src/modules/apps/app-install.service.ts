/**
 * Apps catalog + one-click installer.
 *
 * "template" apps are instantiated here: reuse the standard project-create path
 * (which carries the Phase-1 `isApp`/`appTemplateId` marker), seed the template's
 * compose service rows, and write config/secret env. The caller then deploys the
 * resulting services project through the normal deploy flow. "flow" apps (mail)
 * aren't projects — the installer just returns the wizard route to hand off to.
 */

import { randomBytes, createHmac } from "node:crypto";
import {
  getAppManagement,
  getAppEndpoints,
  declaredServiceRoutes,
  defaultAppRouteLabel,
  normalizeCustomHostname,
  isValidCustomHostname,
  resolveServiceHostnameLabel,
  slugify,
  ConflictError,
  type AppConfigField,
  type AppTemplate,
  type TemplateServiceSpec,
} from "@repo/core";
import { getRuntimeCatalog, getTemplateForOrg, listOrgCustomApps } from "./catalog-source";
import { repos } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { parseServicePort } from "../../lib/deployable-service";
import { requireCloud } from "../../lib/cloud/require-cloud";
import { createProject } from "../projects/project-crud.service";
import { createService, updateService, setServiceEnvVars } from "../services/service.service";

/**
 * Strong random value for generated secrets (Convex INSTANCE_SECRET, DB
 * passwords). 32 bytes → 64 hex chars: Convex self-hosted requires exactly a
 * 32-byte hex INSTANCE_SECRET (like `openssl rand -hex 32`) and the backend
 * exits 255 on boot with anything shorter — 24 bytes silently broke it. 32
 * bytes is also fine (stronger) for every other generated secret.
 */
function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Sign a Supabase-style HS256 JWT (the anon / service_role API keys) with the
 * deployment's JWT secret. `node:crypto` HMAC — no dependency, same primitive as
 * the webhook signers. A 10-year expiry matches Supabase's self-hosted keys.
 */
function signHs256Jwt(secret: string, role: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    role,
    iss: "supabase",
    iat: now,
    exp: now + 60 * 60 * 24 * 365 * 10,
  })}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

/**
 * Catalog for the Create-App UI. Only operator-supplied config fields are
 * returned as form inputs — `generate:"secret"` fields are filled server-side and
 * never surfaced.
 */
export async function getAppCatalog(ctx: RequestContext) {
  const custom = await listOrgCustomApps(ctx.organizationId);
  return [...getRuntimeCatalog(), ...custom].map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    kind: t.kind,
    logo: t.logo,
    category: t.category,
    tags: t.tags ?? [],
    flowHref: t.flowHref,
    // How the installed app is managed (schema settings / custom href / none).
    management: getAppManagement(t),
    // Verified trust mark (official open-source image + reviewed pipeline).
    verified: !!t.verified,
    // A per-org user-uploaded app — always unverified; dashboard shows the warning.
    custom: !!t.custom,
    // Not installable this version → dashboard dims it + blocks the click.
    comingSoon: !t.available,
    // Needs a newer Openship than this instance → dashboard shows a guided
    // "Requires Openship ≥ X" state; install is refused server-side too.
    requiresUpdate: t.requiresUpdate,
    updateAvailable: t.updateAvailable,
    // Exposable endpoints (http/tcp) — parity with the in-package template the
    // wizard reads directly; lets API consumers see what an install exposes.
    endpoints: getAppEndpoints(t),
    configFields: (t.configFields ?? [])
      .filter((f) => !f.generate)
      .map((f) => ({
        key: f.key,
        service: f.service,
        label: f.label,
        help: f.help,
        type: f.type ?? "text",
        default: f.default,
        required: f.required ?? false,
      })),
  }));
}

/**
 * This org's not-yet-deployed draft of an app, if it has one.
 *
 * The install wizard needs it: the catalog tiles link to `/apps/new/<id>` with no
 * `?projectId=`, so without this the wizard rendered template defaults while
 * Install landed on the existing draft — the operator's earlier choices silently
 * replaced by whatever the pickers happened to show.
 */
export async function findOpenAppDraft(
  ctx: RequestContext,
  templateId: string,
): Promise<{ projectId: string; slug: string; name: string } | null> {
  const draft = await repos.project.findDraftByAppTemplate(ctx.organizationId, templateId);
  return draft ? { projectId: draft.id, slug: draft.slug, name: draft.name } : null;
}

/** One endpoint's routing choice, exactly as the install wizard asked it. */
export interface InstallAppRoute {
  /** Template service name. */
  service: string;
  /** Container port this choice routes. */
  port: number;
  /** port = no public route (published host port only). */
  mode: "port" | "free" | "custom";
  /** free mode: subdomain slug. Blank = the template's default label. */
  domain?: string;
  /** custom mode: the hostname the operator owns (required). */
  customDomain?: string;
}

export interface InstallAppInput {
  templateId: string;
  name?: string;
  config?: Record<string, string>;
  /** Per-endpoint routing the operator CHOSE. A service with no entry gets no
   *  public route — see planInstallRouting. */
  routes?: InstallAppRoute[];
}

interface PlannedEndpoint {
  port: number;
  domainType: "free" | "custom";
  domain?: string;
  customDomain?: string;
}

/** Container ports a template service actually serves on — the only ports a
 *  route may target (anything else proxies to a port nothing listens on).
 *  `declaredServiceRoutes` owns the routes+exposedPort union (and its dedup);
 *  we just fold in the compose-style `ports` specs on top. */
function routablePorts(svc: TemplateServiceSpec): Set<number> {
  const out = new Set<number>();
  for (const route of declaredServiceRoutes(svc)) out.add(route.port);
  for (const spec of svc.ports ?? []) {
    const port = parseServicePort(spec);
    if (port != null) out.add(port);
  }
  return out;
}

/**
 * Reject a routing choice that can't produce a working route, BEFORE anything is
 * written: an unknown service/port, a duplicate, or a custom domain that is
 * missing or not a hostname. `free` needs no hostname — the caller explicitly
 * asked for the template's default label when it sends no slug — but a slug that
 * normalizes to nothing is a typo, not a choice.
 *
 * The SHAPE gate matters as much as the presence gate, and it has to run here:
 * `isValidCustomHostname` used to be reached only inside `createService`, i.e.
 * AFTER `createProject`, so `myhost` / `example.com:8443` / `api.example.com/app`
 * left behind a project row with zero services — a dead draft the operator could
 * only escape by renaming or deleting it.
 */
function assertInstallRoutes(
  template: Pick<AppTemplate, "services">,
  routes: readonly InstallAppRoute[] | undefined,
): void {
  const byName = new Map((template.services ?? []).map((s) => [s.name, s]));
  const seen = new Set<string>();
  for (const route of routes ?? []) {
    const svc = byName.get(route.service);
    if (!svc) throw new Error(`This app has no service named "${route.service}".`);
    if (!routablePorts(svc).has(route.port)) {
      throw new Error(`Service "${route.service}" doesn't serve port ${route.port}.`);
    }
    const key = `${route.service}:${route.port}`;
    if (seen.has(key)) throw new Error(`Duplicate routing choice for ${key}.`);
    seen.add(key);
    if (route.mode === "custom") {
      const host = normalizeCustomHostname(route.customDomain ?? "");
      if (!host) {
        throw new Error(`Enter the domain for "${route.service}", or choose port-only access.`);
      }
      if (!isValidCustomHostname(host)) {
        throw new Error(
          `"${host}" isn't a valid domain name. Use a hostname like app.example.com — no scheme, port or path.`,
        );
      }
    }
    if (route.mode === "free" && route.domain?.trim() && !/[a-z0-9]/i.test(route.domain)) {
      throw new Error(`"${route.domain}" isn't a valid subdomain for "${route.service}".`);
    }
  }
}

/**
 * The routing to persist per service, built ONLY from what the operator chose.
 *
 * No free-domain default anywhere: a port with no choice — or an explicit "port"
 * choice — is stored unrouted, so no dead hostname is persisted and the deploy's
 * free-domain gate isn't tripped by a route nobody asked for.
 *
 * That includes a template SECONDARY route (a declared `slugSuffix` port, e.g.
 * Convex's 3211 HTTP-actions port). It used to inherit the primary's free
 * hostname family, which minted a live *.opsh.io route, cloud registration, vhost
 * and cert for a port the wizard never displayed. The wizard now offers one
 * picker per DECLARED route (see `declaredServiceRoutes`), so every hostname here
 * exists because a human saw it and chose it. An unchosen `{{publicUrl:svc:port}}`
 * token resolves against the published host port instead — never against a
 * hostname invented on the operator's behalf.
 */
export function planInstallRouting(
  template: Pick<AppTemplate, "services">,
  projectLabel: string,
  routes: readonly InstallAppRoute[] | undefined,
): Map<string, { exposed: boolean; publicEndpoints: PlannedEndpoint[] }> {
  const chosenByService = new Map<string, InstallAppRoute[]>();
  for (const route of routes ?? []) {
    const list = chosenByService.get(route.service) ?? [];
    list.push(route);
    chosenByService.set(route.service, list);
  }

  const plan = new Map<string, { exposed: boolean; publicEndpoints: PlannedEndpoint[] }>();
  for (const svc of template.services ?? []) {
    const chosen = chosenByService.get(svc.name) ?? [];
    const choiceByPort = new Map(chosen.map((c) => [c.port, c]));
    const declaredRoutes = declaredServiceRoutes(svc);
    const suffixByPort = new Map(declaredRoutes.map((r) => [r.port, r.slugSuffix]));
    // Declared order first so the template's primary route stays the primary
    // (entry[0] mirrors the scalar routing columns), then any other chosen port.
    const declared = declaredRoutes.map((r) => r.port);
    const ports = [...declared, ...chosen.map((c) => c.port).filter((p) => !declared.includes(p))];

    const publicEndpoints: PlannedEndpoint[] = [];
    for (const port of ports) {
      const choice = choiceByPort.get(port);
      if (choice?.mode === "custom") {
        publicEndpoints.push({
          port,
          domainType: "custom",
          customDomain: normalizeCustomHostname(choice.customDomain ?? ""),
        });
      } else if (choice?.mode === "free") {
        const typed = choice.domain?.trim();
        const slug = typed
          ? resolveServiceHostnameLabel(projectLabel, svc.name, typed, "compose")
          : defaultAppRouteLabel(projectLabel, svc.name, suffixByPort.get(port));
        publicEndpoints.push({ port, domainType: "free", domain: slug });
      }
    }

    plan.set(svc.name, { exposed: publicEndpoints.length > 0, publicEndpoints });
  }
  return plan;
}

export type InstallAppResult =
  | { kind: "flow"; flowHref: string }
  | { kind: "template"; projectId: string; slug: string };

export async function installApp(
  ctx: RequestContext,
  input: InstallAppInput,
): Promise<InstallAppResult> {
  const template = await getTemplateForOrg(ctx.organizationId, input.templateId);
  if (!template) throw new Error("unknown-app-template");

  // Version gate: an app needing a newer Openship isn't installable here. Refuse
  // with a guided message (mirrors the dashboard's "Requires Openship ≥ X" card)
  // so a direct API call can't bypass it.
  if (template.requiresUpdate) {
    const v = template.requiresUpdate.minVersion;
    throw new Error(
      v
        ? `This app requires Openship ${v} or newer. Update your instance to install it.`
        : `This app requires a newer version of Openship. Update your instance to install it.`,
    );
  }

  // Server-side gate: a "coming soon" app is dimmed in the UI, but also refuse
  // it here so a direct API call can't install a not-yet-enabled app.
  if (!template.available) throw new Error("app-not-available");

  if (template.kind === "flow") {
    return { kind: "flow", flowHref: template.flowHref ?? "/" };
  }

  assertInstallRoutes(template, input.routes);

  // Gate the operator's CHOSEN routing before the first row is written: a free
  // *.opsh.io hostname only resolves behind the Cloud edge, so a disconnected
  // instance must refuse up front instead of persisting a dead route and failing
  // a later correction. Same capability the wizard pre-checks, so UI and API
  // can't disagree.
  if ((input.routes ?? []).some((route) => route.mode === "free")) {
    await requireCloud("managed-project-domain", { organizationId: ctx.organizationId });
  }

  const baseName = input.name?.trim() || template.name;

  // Re-opening a same-named, not-yet-deployed draft ADOPTS it (so the wizard's
  // Install/Advanced re-click doesn't duplicate). Matched on the exact slug so a
  // DIFFERENT name still creates a new instance — multiple apps of one type are
  // supported.
  //
  // Adopting is not "return early": this request carries a routing DECISION, and
  // returning the draft untouched accepted, validated and cloud-gated `routes`
  // and then dropped them. A failed first deploy leaves the draft a draft, so the
  // only way back is through here — the operator's second, corrected choice
  // (say a custom domain) has to land on the draft's existing service rows.
  const existingDraft = await repos.project.findDraftByAppTemplate(
    ctx.organizationId,
    template.id,
    slugify(baseName),
  );

  // Reuse the standard create path (owns slug/group/route state + the
  // isApp/appTemplateId marker). Auto-suffix the name until its slug is free so
  // a second install of the same app ("Convex" → "Convex 2") doesn't collide;
  // createProject owns the real uniqueness check, so we just retry its throw.
  let project: { id: string; slug: string; name: string };
  if (existingDraft) {
    project = existingDraft;
  } else {
    let created: Awaited<ReturnType<typeof createProject>> | undefined;
    for (let n = 1; ; n++) {
      const name = n === 1 ? baseName : `${baseName} ${n}`;
      try {
        created = await createProject(
          {
            name,
            framework: template.framework ?? "docker-compose",
            projectType: "services",
            hasBuild: false,
            isApp: true,
            appTemplateId: template.id,
          },
          ctx.organizationId,
        );
        break;
      } catch (err) {
        if (err instanceof ConflictError && n < 50) continue;
        throw err;
      }
    }
    project = created!;
  }

  // Resolve config values. Secrets sharing a `generateGroup` get ONE generated
  // value (e.g. a DB password that must match across two services).
  const groupSecret = new Map<string, string>();
  // Pre-generate every grouped secret so generate:"jwt" fields can sign with
  // them regardless of field order (the JWT secret must exist before the keys).
  for (const field of template.configFields ?? []) {
    if (field.generate === "secret" && field.generateGroup && !groupSecret.has(field.generateGroup)) {
      groupSecret.set(field.generateGroup, generateSecret());
    }
  }
  const valueFor = (field: AppConfigField): string => {
    if (field.generate === "secret") {
      if (field.generateGroup) {
        const existing = groupSecret.get(field.generateGroup);
        if (existing) return existing;
        const secret = generateSecret();
        groupSecret.set(field.generateGroup, secret);
        return secret;
      }
      return generateSecret();
    }
    if (field.generate === "jwt") {
      const secret = field.jwtSecretGroup ? groupSecret.get(field.jwtSecretGroup) : undefined;
      if (!secret || !field.jwtRole) return "";
      return signHs256Jwt(secret, field.jwtRole);
    }
    return input.config?.[field.key] ?? field.default ?? "";
  };

  // Resolve each field's final value EXACTLY once (a non-grouped secret would
  // otherwise differ between the env write and the file substitution below).
  const resolved = new Map<string, string>();
  for (const field of template.configFields ?? []) resolved.set(field.key, valueFor(field));

  // Inline generated config values (`{{config:KEY}}`) now — in both service env
  // and mounted files — while leaving `{{publicUrl:…}}` for deploy-time. This
  // lets a service env embed a generated secret it can't otherwise interpolate
  // (e.g. a full `postgres://user:PASSWORD@db/…` connection URL).
  const inlineConfig = (s: string): string =>
    s.replace(/\{\{\s*config:([A-Za-z0-9_]+)\s*\}\}/g, (_m, k) => resolved.get(k) ?? "");

  // Resolve template files per service.
  const filesByService = new Map<string, { path: string; content: string }[]>();
  for (const f of template.files ?? []) {
    const list = filesByService.get(f.service) ?? [];
    list.push({ path: f.path, content: inlineConfig(f.content) });
    filesByService.set(f.service, list);
  }

  // `secretEnv` declares which of a service's env keys are secrets — stored
  // encrypted, never written as plaintext compose env. Wired here (the field was
  // previously inert): a listed key sourced from `environment` is re-routed into
  // the encrypted vars, and a configField whose key is listed is forced secret.
  const secretKeysByService = new Map<string, ReadonlySet<string>>(
    (template.services ?? []).map((s) => [s.name, new Set(s.secretEnv ?? [])] as const),
  );
  const varsByService = new Map<string, { key: string; value: string; isSecret: boolean }[]>();

  // The operator's routing, resolved once for the whole stack.
  const routingPlan = planInstallRouting(template, project.slug ?? project.name, input.routes);

  // Rows the adopted draft already has. A fresh project has none, so the loop
  // below reduces to a plain seed.
  const existingRows = existingDraft ? await repos.service.listByProject(project.id) : [];
  const rowByName = new Map(existingRows.map((s) => [s.name, s]));
  // Only services this call CREATED get config/secret env written. Re-writing a
  // generated secret onto an adopted row would rotate it (Convex's
  // INSTANCE_SECRET invalidates the admin key), so an existing row keeps its own.
  const createdServices = new Set<string>();

  // Seed the compose service rows — or, on an adopted draft, re-apply the chosen
  // routing to the rows that already exist and seed only what's missing (a first
  // install that died part-way left the project with fewer rows than the template).
  for (const svc of template.services ?? []) {
    const routing = routingPlan.get(svc.name) ?? { exposed: false, publicEndpoints: [] };
    const existingRow = rowByName.get(svc.name);

    if (existingRow) {
      // No `routes` in the request = no decision expressed; leave the draft's
      // stored routing alone rather than silently unrouting it.
      if ((input.routes ?? []).length > 0) {
        await updateService(ctx, project.id, existingRow.id, {
          exposed: routing.exposed,
          // Always the FULL array: a scalar-only patch loses to the stored array,
          // which is how a corrected custom domain came back as the old free route.
          publicEndpoints: routing.publicEndpoints,
          ...(routing.publicEndpoints[0]
            ? { domainType: routing.publicEndpoints[0].domainType }
            : {}),
        });
      }
      continue;
    }

    // Split env: keys listed in this service's `secretEnv` go to the encrypted
    // vars path below; the rest stay as plaintext compose env.
    const svcSecretKeys = secretKeysByService.get(svc.name) ?? new Set<string>();
    const plainEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(svc.environment ?? {})) {
      const val = inlineConfig(v);
      if (svcSecretKeys.has(k)) {
        const list = varsByService.get(svc.name) ?? [];
        list.push({ key: k, value: val, isSecret: true });
        varsByService.set(svc.name, list);
      } else {
        plainEnv[k] = val;
      }
    }

    await createService(ctx, project.id, {
      name: svc.name,
      image: svc.image,
      ports: svc.ports ? [...svc.ports] : [],
      dependsOn: svc.dependsOn ? [...svc.dependsOn] : [],
      environment: plainEnv,
      volumes: svc.volumes ? [...svc.volumes] : [],
      command: svc.command,
      restart: svc.restart,
      advanced: {
        ...(svc.healthcheck ? { healthcheck: svc.healthcheck } : {}),
        ...(filesByService.get(svc.name)?.length
          ? { files: filesByService.get(svc.name) }
          : {}),
      },
      // Routing is exactly what the operator chose — never the template's
      // `exposed` flag turned into a hostname.
      exposed: routing.exposed,
      exposedPort: svc.exposedPort != null ? String(svc.exposedPort) : undefined,
      domainType: routing.publicEndpoints[0]?.domainType,
      publicEndpoints: routing.publicEndpoints,
    });
    createdServices.add(svc.name);
  }

  // Write config/secret env per service. A value is encrypted when the field is
  // `secret` OR its key is listed in the service's `secretEnv`.
  for (const field of template.configFields ?? []) {
    if (!createdServices.has(field.service)) continue;
    const value = resolved.get(field.key) ?? "";
    if (!value) continue;
    const list = varsByService.get(field.service) ?? [];
    list.push({
      key: field.key,
      value,
      isSecret: !!field.secret || !!secretKeysByService.get(field.service)?.has(field.key),
    });
    varsByService.set(field.service, list);
  }
  if (varsByService.size > 0) {
    const services = await repos.service.listByProject(project.id);
    const idByName = new Map(services.map((s) => [s.name, s.id]));
    for (const [svcName, vars] of varsByService) {
      const serviceId = idByName.get(svcName);
      if (serviceId) {
        await setServiceEnvVars(ctx, project.id, serviceId, { environment: "production", vars });
      }
    }
  }

  return { kind: "template", projectId: project.id, slug: project.slug };
}
