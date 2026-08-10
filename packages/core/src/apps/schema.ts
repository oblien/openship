import { z } from "zod";
import { compareSemver } from "../updates/semver";

/**
 * Runtime shape gate for a repo-fetched app-catalog overlay. The BUNDLED catalog
 * is generated + trusted; both paths now run through the SAME validator (the
 * bundled set is asserted at boot, remote entries at ingest). Behavior-driving
 * fields (services/images/volumes/commands, config, files, endpoints, prepare,
 * connection) are validated strictly, AND cross-field references are checked
 * (see `.superRefine` below). Extra/unknown keys are ignored (zod strips on
 * parse but safeParse still succeeds), so forward-added fields never falsely
 * reject — callers keep the RAW object so those fields survive the cache.
 *
 * Versioning: an entry may declare `schemaVersion` (absent ⇒ 1) and `minEngine`.
 * `parseAppTemplate` gates both — an entry authored for a newer schema, or
 * needing a newer engine, is rejected with a typed reason so the overlay can
 * drop-with-last-good instead of mis-installing.
 */

/** Highest catalog `schemaVersion` this build understands. An overlay entry
 *  above this is dropped (kept last-good), never mis-installed. Bump in lockstep
 *  with CURRENT_SCHEMA_VERSION when a breaking shape change ships. */
export const MAX_SUPPORTED_SCHEMA = 1;

/**
 * Is a template's `minEngine` satisfied by this instance's Openship version?
 * No `minEngine` (or no known engine) ⇒ always ok. Shared by the catalog
 * resolver + the install gate so "needs a newer Openship" is decided one way.
 */
export function templateEngineOk(
  minEngine: string | undefined,
  engineVersion: string | undefined,
): boolean {
  if (!minEngine || !engineVersion) return true;
  return compareSemver(engineVersion, minEngine) >= 0;
}

const serviceSpec = z.object({
  name: z.string(),
  image: z.string(),
  ports: z.array(z.string()).optional(),
  exposedPort: z.number().optional(),
  routes: z
    .array(z.object({ port: z.number(), slugSuffix: z.string().optional() }))
    .optional(),
  environment: z.record(z.string(), z.string()).optional(),
  secretEnv: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  exposed: z.boolean().optional(),
  healthcheck: z.unknown().optional(),
  restart: z.enum(["no", "always", "on-failure", "unless-stopped"]).optional(),
  command: z.string().optional(),
});

const configField = z.object({
  key: z.string(),
  service: z.string(),
  label: z.string(),
  help: z.string().optional(),
  type: z.enum(["text", "password"]).optional(),
  default: z.string().optional(),
  generate: z.enum(["secret", "jwt"]).optional(),
  generateGroup: z.string().optional(),
  jwtSecretGroup: z.string().optional(),
  jwtRole: z.string().optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
});

/** A catalog string that may be a plain value OR an inline per-locale map. */
const localized = z.union([z.string(), z.record(z.string(), z.string())]);

const prepareStep = z.object({
  service: z.string(),
  command: z.string(),
  capture: z.string(),
  capturePattern: z.string().optional(),
  persistAs: z.object({ key: z.string(), secret: z.boolean().optional() }).optional(),
  once: z.boolean().optional(),
  phase: z.enum(["pre-deploy", "post-start", "post-ready"]).optional(),
  mustSucceed: z.boolean().optional(),
  readiness: z
    .object({ test: z.string(), interval: z.number().optional(), retries: z.number().optional() })
    .optional(),
  // Authored display copy for the install stepper's "app-setup" sub-steps. Purely
  // presentational; absent → the renderer uses a generic label.
  title: localized.optional(),
  description: localized.optional(),
  icon: z.string().optional(),
});

const outputVariant = z.object({
  id: z.string(),
  label: z.union([z.string(), z.record(z.string(), z.string())]),
  source: z.string(),
});

const connection = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  outputs: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      help: z.string().optional(),
      source: z.string(),
      secret: z.boolean().optional(),
      envKey: z.string().optional(),
      /** Source service (docker alias) this output belongs to — authoritative
       *  for internal-mode host rewriting; validated against declared services
       *  in the superRefine below. */
      service: z.string().optional(),
      recommended: z.boolean().optional(),
      sourceLabel: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
      variants: z.array(outputVariant).optional(),
      width: z.enum(["full", "half"]).optional(),
      /** "url" marks the resolved value as an openable link — the Connection
       *  card shows an Open-in-new-tab action beside it. Enforced only for a
       *  resolved http(s) value (checked at render); default "text". Additive. */
      kind: z.enum(["text", "url"]).optional(),
    }),
  ),
  guide: z
    .object({
      // string OR an inline { locale: string } map (localized in the catalog)
      intro: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
      useHint: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
      defaultMode: z.enum(["internal", "public"]).optional(),
    })
    .optional(),
  // Static default credentials the app ships with (e.g. Grafana admin/admin).
  // These are FIXED values, not derived from a service env, so they can't live in
  // `outputs` (whose values resolve from running services) — hence their own field.
  firstLogin: z
    .object({
      username: localized.optional(),
      password: localized.optional(),
      note: localized.optional(),
    })
    .optional(),
});

const endpointMode = z.enum(["domain", "port", "publish", "internal"]);
const endpoint = z.object({
  service: z.string(),
  port: z.number(),
  label: z.string(),
  kind: z.enum(["http", "tcp"]),
  required: z.boolean().optional(),
  scope: z.enum(["public", "internal", "local"]).optional(),
  defaultMode: endpointMode.optional(),
  allowedModes: z.array(endpointMode).optional(),
});

const provides = z.object({
  id: z.string(),
  outputRefs: z.array(z.string()),
  category: z.string().optional(),
});
const requires = z.object({
  id: z.string(),
  label: localized,
  category: z.string().optional(),
  envKey: z.string(),
  mode: z.enum(["internal", "public"]).optional(),
  optional: z.boolean().optional(),
});

const file = z.object({
  service: z.string(),
  path: z.string(),
  content: z.string(),
});

const settingOption = z.object({ value: z.string(), label: z.string() });

const settingField = z.object({
  key: z.string(),
  service: z.string(),
  label: z.string(),
  help: z.string().optional(),
  type: z.enum(["text", "password", "boolean", "select", "number", "multiselect", "radio", "textarea"]),
  options: z.array(settingOption).optional(),
  separator: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  integer: z.boolean().optional(),
  pattern: z.string().optional(),
  patternError: z.string().optional(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  secret: z.boolean().optional(),
  trueValue: z.string().optional(),
  falseValue: z.string().optional(),
  requiresRedeploy: z.boolean().optional(),
  advanced: z.boolean().optional(),
  installStep: z.boolean().optional(),
  required: z.boolean().optional(),
  showIf: z
    .object({
      field: z.string(),
      service: z.string().optional(),
      equals: z.union([z.string(), z.array(z.string())]).optional(),
      truthy: z.boolean().optional(),
    })
    .optional(),
});

const settingGroup = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  fields: z.array(settingField),
});

const management = z.union([
  z.object({ kind: z.literal("schema") }),
  z.object({ kind: z.literal("custom"), href: z.string() }),
]);

export const appTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["template", "flow"]),
  logo: z.string(),
  category: z.enum(["backend", "database", "cms", "mail", "analytics", "automation", "other"]),
  tags: z.array(z.string()).optional(),
  framework: z.string().optional(),
  services: z.array(serviceSpec).optional(),
  configFields: z.array(configField).optional(),
  flowHref: z.string().optional(),
  settings: z.array(settingGroup).optional(),
  management: management.optional(),
  prepare: z.array(prepareStep).optional(),
  connection: connection.optional(),
  endpoints: z.array(endpoint).optional(),
  files: z.array(file).optional(),
  provides: z.array(provides).optional(),
  requires: z.array(requires).optional(),
  available: z.boolean().optional(),
  verified: z.boolean().optional(),
  // Versioning / compat gate (see parseAppTemplate).
  schemaVersion: z.number().optional(),
  minEngine: z.string().optional(),
  updatedAt: z.string().optional(),
  repository: z.string().url().optional(),
}).superRefine((data, ctx) => {
  // Referential integrity — catch dangling references at the gate rather than at
  // deploy time. Only enforced when the template declares services (flow apps
  // have none). `template:` sources aren't a direct service ref (they embed
  // {{env:svc:KEY}} placeholders), so only env:/publicUrl: sources are checked.
  const svcNames = new Set((data.services ?? []).map((s) => s.name));
  const refSvc = (service: string, path: (string | number)[], where: string) => {
    if (svcNames.size > 0 && !svcNames.has(service)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `${where} references unknown service "${service}"` });
    }
  };
  (data.configFields ?? []).forEach((f, i) => refSvc(f.service, ["configFields", i, "service"], "configField"));
  (data.prepare ?? []).forEach((p, i) => refSvc(p.service, ["prepare", i, "service"], "prepare"));
  (data.endpoints ?? []).forEach((e, i) => refSvc(e.service, ["endpoints", i, "service"], "endpoint"));
  (data.files ?? []).forEach((f, i) => refSvc(f.service, ["files", i, "service"], "file"));
  (data.settings ?? []).forEach((g, gi) =>
    g.fields.forEach((f, fi) => refSvc(f.service, ["settings", gi, "fields", fi, "service"], "setting")),
  );

  const SOURCE_RE = /^(env:[^:]+:[^:]+|publicUrl:[^:]+(:\d+)?|template:.*)$/;
  const checkSource = (source: string, path: (string | number)[], where: string) => {
    if (!SOURCE_RE.test(source)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `invalid ${where} source "${source}"` });
    }
    const m = source.match(/^(?:env|publicUrl):([^:]+)/);
    if (m) refSvc(m[1]!, path, where);
  };
  (data.connection?.outputs ?? []).forEach((o, i) => {
    checkSource(o.source, ["connection", "outputs", i, "source"], "output");
    // An explicit output.service (needed when a `template:` source can't carry
    // the service) must name a declared service — it's the internal-mode alias.
    if (o.service) refSvc(o.service, ["connection", "outputs", i, "service"], "output");
    (o.variants ?? []).forEach((v, j) => {
      checkSource(v.source, ["connection", "outputs", i, "variants", j, "source"], "variant");
    });
  });

  // jwtSecretGroup must point at a declared generateGroup among configFields.
  const groups = new Set((data.configFields ?? []).map((f) => f.generateGroup).filter(Boolean));
  (data.configFields ?? []).forEach((f, i) => {
    if (f.jwtSecretGroup && !groups.has(f.jwtSecretGroup)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["configFields", i, "jwtSecretGroup"], message: `jwtSecretGroup "${f.jwtSecretGroup}" has no matching generateGroup` });
    }
  });

  // flowHref must be an internal route (never an external URL).
  if (data.flowHref !== undefined && !data.flowHref.startsWith("/")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["flowHref"], message: "flowHref must be an internal route starting with /" });
  }

  // provides.outputRefs must reference declared connection.outputs ids.
  const outputIds = new Set((data.connection?.outputs ?? []).map((o) => o.id));
  (data.provides ?? []).forEach((p, i) => {
    p.outputRefs.forEach((ref, j) => {
      if (!outputIds.has(ref)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provides", i, "outputRefs", j], message: `provides references unknown output "${ref}"` });
      }
    });
  });
});

/** True if `raw` is a well-formed AppTemplate SHAPE (no version/engine gate).
 *  Kept for the bundled boot-assert + the catalog drift test; the overlay ingest
 *  uses `parseAppTemplate` for the full version/engine-aware decision. */
export function isValidAppTemplate(raw: unknown): boolean {
  return appTemplateSchema.safeParse(raw).success;
}

/** Why an entry was rejected — lets the overlay log a precise drop notice. */
export type AppTemplateRejection =
  | { ok: false; reason: "shape"; detail?: string }
  | { ok: false; reason: "schema-too-new"; detail: string }
  | { ok: false; reason: "engine-too-new"; detail: string };

/**
 * Full ingest decision for one catalog entry: shape + schemaVersion + minEngine.
 * Returns `{ ok: true }` (the CALLER keeps the raw object, so forward-added
 * fields survive) or a typed rejection. `engineVersion` is this instance's
 * Openship version; omit to skip the engine gate (e.g. in pure-shape tests).
 */
export function parseAppTemplate(
  raw: unknown,
  opts?: { engineVersion?: string },
): { ok: true } | AppTemplateRejection {
  const parsed = appTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "shape", detail: parsed.error.issues[0]?.message };
  }
  const schemaVersion = parsed.data.schemaVersion ?? 1;
  if (schemaVersion > MAX_SUPPORTED_SCHEMA) {
    return { ok: false, reason: "schema-too-new", detail: `schemaVersion ${schemaVersion}` };
  }
  const minEngine = parsed.data.minEngine;
  if (minEngine && opts?.engineVersion && compareSemver(opts.engineVersion, minEngine) < 0) {
    return { ok: false, reason: "engine-too-new", detail: `minEngine ${minEngine}` };
  }
  return { ok: true };
}
