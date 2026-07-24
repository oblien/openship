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
  resolveServiceHostnameLabel,
  slugify,
  ConflictError,
  type AppConfigField,
} from "@repo/core";
import { getRuntimeCatalog, getRuntimeTemplate } from "./catalog-source";
import { repos } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { createProject } from "../projects/project-crud.service";
import { createService, setServiceEnvVars } from "../services/service.service";

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
export function getAppCatalog() {
  return getRuntimeCatalog().map((t) => ({
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
    // Not installable this version → dashboard dims it + blocks the click.
    comingSoon: !t.available,
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

export interface InstallAppInput {
  templateId: string;
  name?: string;
  config?: Record<string, string>;
}

export type InstallAppResult =
  | { kind: "flow"; flowHref: string }
  | { kind: "template"; projectId: string; slug: string };

export async function installApp(
  ctx: RequestContext,
  input: InstallAppInput,
): Promise<InstallAppResult> {
  const template = getRuntimeTemplate(input.templateId);
  if (!template) throw new Error("unknown-app-template");

  // Server-side gate: a "coming soon" app is dimmed in the UI, but also refuse
  // it here so a direct API call can't install a not-yet-enabled app.
  if (!template.available) throw new Error("app-not-available");

  if (template.kind === "flow") {
    return { kind: "flow", flowHref: template.flowHref ?? "/" };
  }

  const baseName = input.name?.trim() || template.name;

  // Re-opening a same-named, not-yet-deployed draft returns it (so the wizard's
  // Install/Advanced re-click doesn't duplicate). Matched on the exact slug so a
  // DIFFERENT name still creates a new instance — multiple apps of one type are
  // supported. Return BEFORE seeding so nothing is duplicated.
  const existingDraft = await repos.project.findDraftByAppTemplate(
    ctx.organizationId,
    template.id,
    slugify(baseName),
  );
  if (existingDraft) {
    return { kind: "template", projectId: existingDraft.id, slug: existingDraft.slug };
  }

  // Reuse the standard create path (owns slug/group/route state + the
  // isApp/appTemplateId marker). Auto-suffix the name until its slug is free so
  // a second install of the same app ("Convex" → "Convex 2") doesn't collide;
  // createProject owns the real uniqueness check, so we just retry its throw.
  let project;
  for (let n = 1; ; n++) {
    const name = n === 1 ? baseName : `${baseName} ${n}`;
    try {
      project = await createProject(
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

  // Seed the compose service rows.
  for (const svc of template.services ?? []) {
    // Multi-port apps (e.g. Convex: 3210 API + 3211 HTTP actions) declare one
    // route per port. Give each its own free subdomain — the primary uses the
    // default `<app>-<service>` label, secondaries append their slugSuffix — so
    // {{publicUrl:svc:port}} resolves to distinct hostnames.
    const publicEndpoints =
      svc.routes && svc.routes.length > 0
        ? svc.routes.map((route) => {
            const label = resolveServiceHostnameLabel(
              project.slug ?? project.name,
              svc.name,
              undefined,
              "compose",
            );
            return {
              port: route.port,
              domainType: "free" as const,
              domain: route.slugSuffix ? `${label}-${route.slugSuffix}` : label,
            };
          })
        : undefined;

    await createService(ctx, project.id, {
      name: svc.name,
      image: svc.image,
      ports: svc.ports ? [...svc.ports] : [],
      dependsOn: svc.dependsOn ? [...svc.dependsOn] : [],
      environment: Object.fromEntries(
        Object.entries(svc.environment ?? {}).map(([k, v]) => [k, inlineConfig(v)]),
      ),
      volumes: svc.volumes ? [...svc.volumes] : [],
      command: svc.command,
      restart: svc.restart,
      advanced: {
        ...(svc.healthcheck ? { healthcheck: svc.healthcheck } : {}),
        ...(filesByService.get(svc.name)?.length
          ? { files: filesByService.get(svc.name) }
          : {}),
      },
      exposed: svc.exposed ?? false,
      exposedPort: svc.exposedPort != null ? String(svc.exposedPort) : undefined,
      domainType: svc.exposed ? "free" : undefined,
      publicEndpoints,
    });
  }

  // Write config/secret env per service (values encrypted when `secret`).
  const varsByService = new Map<string, { key: string; value: string; isSecret: boolean }[]>();
  for (const field of template.configFields ?? []) {
    const value = resolved.get(field.key) ?? "";
    if (!value) continue;
    const list = varsByService.get(field.service) ?? [];
    list.push({ key: field.key, value, isSecret: !!field.secret });
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
