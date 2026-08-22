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
  fitsCapacity,
  hasMinResources,
  normalizeCustomHostname,
  isValidCustomHostname,
  resolveServiceHostnameLabel,
  slugify,
  ConflictError,
  UNKNOWN_CAPACITY,
  type AppConfigField,
  type AppMinResources,
  type AppTemplate,
  type HostCapacity,
  type ResourceFit,
  type TemplateServiceSpec,
  type TemplateServiceBuild,
} from "@repo/core";
import { getRuntimeCatalog, getTemplateForOrg, listOrgCustomApps } from "./catalog-source";
import { repos } from "@repo/db";
import { env } from "../../config";
import { decrypt, encrypt } from "../../lib/encryption";
import type { RequestContext } from "../../lib/request-context";
import { isLocalHostRow } from "../../lib/box-org";
import { parseServicePort } from "../../lib/deployable-service";
import { requireCloud } from "../../lib/cloud/require-cloud";
import { assertPlanAllowsServices } from "../../lib/plan-guard";
import { getTrustedHostCapacity } from "../../lib/host-capacity";
import { createProject } from "../projects/project-crud.service";
import { createService, updateService, setServiceEnvVars } from "../services/service.service";
import { applyBackupDefaults } from "../backups/apply-defaults.service";

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
 *
 * `unlisted` apps are dropped here and only here: they stay installable by id and
 * their wizard still resolves (`catalogEntry` → `getTemplateForOrg`), they just
 * don't get a card. That's how webmail rides along under Openship Mail instead of
 * sitting beside it as a second, near-identical tile.
 */
export async function getAppCatalog(ctx: RequestContext) {
  const custom = await listOrgCustomApps(ctx.organizationId);
  return [...getRuntimeCatalog(), ...custom].filter((t) => !t.unlisted).map((t) => ({
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
    // Hosting model for the catalog badge + wizard notice (self-hosted default).
    hosting: t.hosting ?? "self-hosted",
    // What the app needs from the machine — the wizard shows it against the
    // chosen destination's real capacity, and deploy preflight enforces it.
    minResources: t.minResources,
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

/** One app's declared minimum vs. what a chosen destination actually has. */
export interface AppHostFitView {
  /** What the app says it needs. Null when it declares nothing (most apps). */
  minResources: AppMinResources | null;
  /** What the machine reported. `source: "unknown"` = we couldn't ask, which is
   *  never a refusal — see `fitsCapacity`. */
  capacity: HostCapacity;
  fit: ResourceFit;
}

/**
 * Match an app's declared `minResources` against a destination BEFORE anything is
 * created, so the install wizard can say "PostHog wants 8 GB; this server has 4"
 * next to the picker instead of letting the operator find out from a failed
 * deploy.
 *
 * ADVISORY ONLY. The gate is deploy preflight's `host-capacity` check, reading the
 * same declaration through the same `fitsCapacity` verdict on the same probed
 * numbers — so the notice and the refusal cannot disagree. Same split as the
 * free-domain cloud requirement: the wizard pre-checks, the API enforces.
 */
export async function getAppHostFit(
  ctx: RequestContext,
  templateId: string,
  /** The destination as the wizard has it: cloud, or a server row (none = this box,
   *  which is what an unbound project derives). "This machine" is NOT taken from
   *  here — see below. */
  target: { deployTarget?: string; serverId?: string },
): Promise<AppHostFitView> {
  const template = await getTemplateForOrg(ctx.organizationId, templateId);
  const minResources = template?.minResources ?? null;
  const unchecked: AppHostFitView = {
    minResources,
    capacity: { ...UNKNOWN_CAPACITY },
    fit: { ok: true },
  };

  // Nothing declared → nothing to match. Cloud is sized from the tier table, not
  // from host hardware, so there is no machine to compare against either.
  if (!hasMinResources(minResources) || target.deployTarget === "cloud") return unchecked;

  // A serverId off a query string is read ORG-SCOPED, and an id this org doesn't
  // own reports "unknown" rather than probing another tenant's box.
  //
  // Whether the destination is THIS machine is then DERIVED from that row, never
  // read off the query: `isLocalTarget` is what makes a `source: "local"` probe —
  // the API host's own `os.*` — trusted, so a caller claiming it for a remote
  // server would have matched the app against the orchestrator's RAM and reported
  // a shortfall about the wrong machine. `isLocalHostRow` is the same test the
  // deploy path uses, so the notice and the refusal describe one box.
  let isLocalTarget = !target.serverId && !env.CLOUD_MODE;
  if (target.serverId) {
    const server = await repos.server
      .getInOrganization(target.serverId, ctx.organizationId)
      .catch(() => null);
    if (!server) return unchecked;
    isLocalTarget = await isLocalHostRow(server);
  }

  const capacity = await getTrustedHostCapacity(target.serverId, ctx.organizationId, {
    isLocalTarget,
  });
  return { minResources, capacity, fit: fitsCapacity(minResources, capacity) };
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
  /** Set the template's backup defaults up as part of this install (default:
   *  true, and a no-op when the org has no backup destination). `false` opts
   *  out — an install that wants no schedules attached to it. */
  applyBackupDefaults?: boolean;
  /** Destination the derived policies point at. Omitted ⇒ the org's default. */
  backupDestinationId?: string;
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

/**
 * One plan entry as an `updateService` patch.
 *
 * Exists because the array is not optional. A patch carrying only `domainType` loses to
 * the stored `publicEndpoints`, which is how a corrected custom domain came back as the
 * old free route — so every writer has to send the FULL array, and a rule that every
 * writer has to remember belongs in one place instead. Both the install path and the
 * webmail re-apply path spelled this out separately.
 */
export function serviceRoutingPatch(routing: {
  exposed: boolean;
  publicEndpoints: PlannedEndpoint[];
}): {
  exposed: boolean;
  publicEndpoints: PlannedEndpoint[];
  domainType?: "free" | "custom";
  domain?: null;
  customDomain?: null;
} {
  const primary = routing.publicEndpoints[0];
  return {
    exposed: routing.exposed,
    publicEndpoints: routing.publicEndpoints,
    ...(primary
      ? // The scalar column mirrors entry[0] — the template's primary route.
        { domainType: primary.domainType }
      : // An empty plan is a DECISION, not an absence — the webmail proxy variant's
        // deliberate no-hostname. Omitting the scalars made it unsayable: for an
        // existing row `mergeServiceRoutingPatch` resolves an absent `domainType`
        // from `stored`, so `"custom"` survived, and `customDomain` then resolved
        // from `stored` too. The array cleared while the row kept the hostname it
        // was redeployed to drop — alive in its derived domain row.
        { domainType: "free" as const, domain: null, customDomain: null }),
  };
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

  // Plan gate, before anything is written. Every catalog app becomes a
  // `services` project with image-backed service rows, so it can never be
  // static — a static-only tier is refused here, at the moment the operator
  // clicks Install, rather than at the deploy that follows.
  await assertPlanAllowsServices(ctx.organizationId);

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
    s.replace(CONFIG_TOKEN_RE, (_m, k) => resolved.get(k) ?? "");

  // Resolve template files per service.
  const filesByService = new Map<string, { path: string; content: string }[]>();
  for (const f of template.files ?? []) {
    const list = filesByService.get(f.service) ?? [];
    list.push({ path: f.path, content: inlineConfig(f.content) });
    filesByService.set(f.service, list);
  }

  // Resolve a service's inline build context, if any — `{{config:KEY}}` is
  // inlined in the Dockerfile and every context file's content (the same
  // generated-key surface as env/files). Carried onto `advanced.build`; the
  // deploy pipeline materializes it and builds on the host.
  const resolveBuild = (b: TemplateServiceBuild | undefined) =>
    b
      ? {
          dockerfile: inlineConfig(b.dockerfile),
          ...(b.files?.length
            ? { files: b.files.map((f) => ({ path: f.path, content: inlineConfig(f.content) })) }
            : {}),
        }
      : undefined;

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
  // INSTANCE_SECRET invalidates the admin key), so an existing row keeps its own —
  // and `ensureGeneratedAppSecrets` below is what fills the gap that leaves when the
  // first attempt never got as far as writing them.
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
        await updateService(ctx, project.id, existingRow.id, serviceRoutingPatch(routing));
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
      // Structured argv bypasses the `sh -c` wrap resolveComposeCmd applies to a
      // bare `command`, which some images' entrypoints cannot survive.
      commandArgv: svc.commandArgv ? [...svc.commandArgv] : undefined,
      restart: svc.restart,
      advanced: {
        ...(svc.healthcheck ? { healthcheck: svc.healthcheck } : {}),
        ...(filesByService.get(svc.name)?.length
          ? { files: filesByService.get(svc.name) }
          : {}),
        ...(svc.build ? { build: resolveBuild(svc.build) } : {}),
        ...(svc.stopGracePeriod ? { stopGracePeriod: svc.stopGracePeriod } : {}),
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

  // AFTER the writes above, never before: `setServiceEnvVars` REPLACES a service's
  // whole production scope, so anything backfilled first would be wiped. This is what
  // makes the installer's guarantee unconditional rather than "if the first attempt ran
  // to completion".
  await ensureGeneratedAppSecrets(project.id, template);

  // Backups go last, and can never be fatal. By this point the project, its
  // services and its env are all persisted — the install SUCCEEDED — so a
  // destination that fails to resolve or a policy insert that trips must not
  // turn that into an error the user sees as "install failed". It logs and the
  // user can apply defaults later from the project's backup settings.
  //
  // `applyBackupDefaults` resolves service rows itself rather than borrowing the
  // `idByName` map above: that map only exists when the template had env to
  // write, and the endpoint caller has no map at all.
  if (input.applyBackupDefaults !== false) {
    try {
      await applyBackupDefaults(ctx, project.id, template, {
        destinationId: input.backupDestinationId,
      });
    } catch (err) {
      console.error("[app-install] backup defaults not applied", project.id, err);
    }
  }

  return { kind: "template", projectId: project.id, slug: project.slug };
}

// ─── Generated secrets: reuse-or-mint ────────────────────────────────────────

/** Scope the installer writes generated config values to. */
const GENERATED_ENV_SCOPE = "production";

/** The substitution form `inlineConfig` uses. Shared so the two cannot drift. */
const CONFIG_TOKEN_RE = /\{\{\s*config:([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Config keys the template SUBSTITUTES into some other string — a sibling service's
 * `DATABASE_URL`, a mounted `redis.conf`, a build arg.
 *
 * Those copies are written once, at install, from the value resolved then. Minting a
 * fresh value for such a key later would leave the env row saying A while every inlined
 * copy still says B: an app that cannot reach its own database, with nothing logged.
 * So for these keys a missing row is reported, never invented.
 */
function inlinedConfigKeys(template: AppTemplate): ReadonlySet<string> {
  const keys = new Set<string>();
  const scan = (text: string | undefined | null) => {
    if (!text) return;
    for (const [, key] of text.matchAll(CONFIG_TOKEN_RE)) keys.add(key);
  };
  // The four places `inlineConfig` is applied, and only those.
  for (const svc of template.services ?? []) {
    for (const value of Object.values(svc.environment ?? {})) scan(value);
    scan(svc.build?.dockerfile);
    for (const file of svc.build?.files ?? []) scan(file.content);
  }
  for (const file of template.files ?? []) scan(file.content);
  return keys;
}

/**
 * Make every `generate:` config field the template declares EXIST on the project,
 * minting only what is genuinely missing.
 *
 * `installApp` writes those values for the services one call creates, which made the
 * guarantee conditional on a single uninterrupted pass: an adopted draft keeps whatever
 * the first attempt wrote, and a later attempt skips the write for rows it did not
 * create. Webmail then deploys a container with no `SESSION_ENCRYPTION_KEY`, which its
 * image treats as fatal — a crash loop the deploy reported as success (issue #566).
 *
 * Idempotent and non-destructive, in that order:
 *   - PRESENCE is decided from the RAW stored keys, never from decrypted values.
 *     `decryptEnvMap` drops whatever it cannot decrypt, so after a BETTER_AUTH_SECRET
 *     rotation every secret would read as absent — and `mergeEnvVars` deletes before it
 *     inserts, which would overwrite the only copy of a database password and turn a
 *     recoverable misconfiguration into an unopenable volume.
 *   - a key the template inlines elsewhere is never minted (see above).
 *   - a `generateGroup` is resolved ACROSS services and only ever gets one value. Two
 *     fields in a group are a password that must MATCH (ghost's `ghostdb` spans
 *     ghost-db and ghost), so a per-service map would repair one half of the pair with a
 *     value the other half does not know. Where one member is already stored we reuse
 *     ITS value; where that copy cannot be decrypted the whole group is left alone.
 *
 * Returns the keys it wrote, for the caller's log.
 */
export async function ensureGeneratedAppSecrets(
  projectId: string,
  template: AppTemplate,
): Promise<string[]> {
  const generated = (template.configFields ?? []).filter((f) => f.generate);
  if (generated.length === 0) return [];

  const inlined = inlinedConfigKeys(template);
  const rows = await repos.service.listByProject(projectId);
  const rowByName = new Map(rows.map((r) => [r.name, r]));
  const secretKeysByService = new Map(
    (template.services ?? []).map((s) => [s.name, new Set(s.secretEnv ?? [])] as const),
  );

  // Every service's stored scope, read before anything is decided: a group spans
  // services, so what to do about one field can depend on another service's rows.
  const byService = groupByService(generated);
  const storedByService = new Map<string, Record<string, string>>();
  for (const serviceName of byService.keys()) {
    const row = rowByName.get(serviceName);
    if (row) {
      storedByService.set(
        serviceName,
        await repos.project.getEnvMap(projectId, GENERATED_ENV_SCOPE, row.id),
      );
    }
  }
  // PROJECT scope counts as present. An operator may hold a generated value at project
  // level (`service_id IS NULL`), and the deploy layers service env ABOVE project env —
  // so minting a service-scoped value here would SHADOW theirs and silently rotate the
  // secret out from under a running app. Never mint over a value that is already in use,
  // wherever it is kept.
  const storedAtProject = await repos.project.getEnvMap(projectId, GENERATED_ENV_SCOPE, null);

  const { groupValue, blockedGroups } = resolveGeneratedGroups(
    generated,
    storedByService,
    storedAtProject,
  );

  const written: string[] = [];
  for (const [serviceName, fields] of byService) {
    const row = rowByName.get(serviceName);
    const stored = storedByService.get(serviceName);
    if (!row || !stored) continue;
    const upserts: { key: string; value: string; isSecret: boolean }[] = [];

    for (const field of fields) {
      if (Object.hasOwn(stored, field.key) || Object.hasOwn(storedAtProject, field.key)) continue;
      const group = field.generateGroup ?? field.jwtSecretGroup;
      if (group && blockedGroups.has(group)) {
        console.warn(
          `[apps] ${template.id}: ${serviceName}.${field.key} is missing, but its group "${group}" already has a value elsewhere that cannot be read — leaving it alone rather than writing a value the rest of the group would not match.`,
        );
        continue;
      }
      if (inlined.has(field.key)) {
        console.warn(
          `[apps] ${template.id}: ${serviceName}.${field.key} is missing and is inlined elsewhere in the template — not minting a value that its existing copies would contradict.`,
        );
        continue;
      }
      const value = mintGenerated(field, groupValue);
      if (!value) continue;
      upserts.push({
        key: field.key,
        value: encrypt(value),
        isSecret: !!field.secret || !!secretKeysByService.get(serviceName)?.has(field.key),
      });
      written.push(field.key);
    }

    if (upserts.length > 0) {
      await repos.project.mergeEnvVars(projectId, GENERATED_ENV_SCOPE, upserts, [], row.id);
    }
  }

  if (written.length > 0) {
    console.warn(
      `[apps] ${template.id}: backfilled generated config on ${projectId}: ${written.join(", ")}`,
    );
  }
  return written;
}

/**
 * Seed each `generateGroup` from whatever is already stored, before anything is minted.
 *
 * A group is one shared value across services. Three outcomes per group:
 *   - a stored member we can decrypt → its plaintext becomes the group's value, so the
 *     missing members are REPAIRED to match it instead of rotating the pair;
 *   - a stored member we cannot decrypt → the group is blocked, because any value we
 *     minted would silently disagree with the copy that is already in use;
 *   - nothing stored → left unset, and the first field that needs it mints one.
 */
function resolveGeneratedGroups(
  fields: AppConfigField[],
  storedByService: Map<string, Record<string, string>>,
  storedAtProject: Record<string, string>,
): { groupValue: Map<string, string>; blockedGroups: Set<string> } {
  const groupValue = new Map<string, string>();
  const blockedGroups = new Set<string>();
  for (const field of fields) {
    const group = field.generateGroup;
    if (!group) continue;
    const raw = storedByService.get(field.service)?.[field.key] ?? storedAtProject[field.key];
    if (!raw || groupValue.has(group)) continue;
    try {
      groupValue.set(group, decrypt(raw));
    } catch {
      blockedGroups.add(group);
    }
  }
  // A group whose value we recovered is not blocked, whichever member we read it from.
  for (const group of groupValue.keys()) blockedGroups.delete(group);
  return { groupValue, blockedGroups };
}

function groupByService(fields: AppConfigField[]): Map<string, AppConfigField[]> {
  const out = new Map<string, AppConfigField[]>();
  for (const field of fields) {
    const list = out.get(field.service) ?? [];
    list.push(field);
    out.set(field.service, list);
  }
  return out;
}

/**
 * One generated value, using the same rules as the installer's `valueFor`.
 *
 * `groupValue` is shared across services and may already carry a value recovered from a
 * stored member, which is what makes a repaired half of a pair match the other half. A
 * `generate:"jwt"` field can only be signed with a secret this map knows: with no
 * recovered and no minted secret it yields "" and is left for the operator's reinstall
 * rather than signed with a key nothing else has.
 */
function mintGenerated(field: AppConfigField, groupValue: Map<string, string>): string {
  if (field.generate === "secret") {
    if (!field.generateGroup) return generateSecret();
    const existing = groupValue.get(field.generateGroup);
    if (existing) return existing;
    const secret = generateSecret();
    groupValue.set(field.generateGroup, secret);
    return secret;
  }
  if (field.generate === "jwt") {
    const secret = field.jwtSecretGroup ? groupValue.get(field.jwtSecretGroup) : undefined;
    if (!secret || !field.jwtRole) return "";
    return signHs256Jwt(secret, field.jwtRole);
  }
  return "";
}
