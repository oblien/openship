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

/**
 * An inline Docker build context shipped IN the template — for a service that
 * must be BUILT, not pulled: e.g. a base image that needs extra packages and a
 * provisioning ENTRYPOINT baked in (Neon's compute node). At deploy time the
 * installer materializes this to a temp context on the orchestrator and the
 * normal compose build pipeline runs `docker build` on the deploy host. Building
 * subsumes an entrypoint override — the Dockerfile sets its own ENTRYPOINT.
 * `{{config:KEY}}` is resolved in `dockerfile` and every `files[].content` at
 * install time. A build ARG the Dockerfile declares is fed from the project's
 * build env (the runtime passes env as `--build-arg`), so no separate args map.
 *
 * COPY-path semantics (boot-verified): every buildable service is materialized
 * under a subdir named after the service, inside ONE shared context root, and
 * `docker build` runs with that shared root as its context. So COPY/ADD sources
 * are relative to the root — a `files[]` entry `compute.sh` on service `compute`
 * is copied with `COPY compute/compute.sh …`, NOT `COPY compute.sh …`.
 */
const serviceBuild = z.object({
  /** Full Dockerfile contents (inline). COPY sources are `<service-name>/<path>`. */
  dockerfile: z.string(),
  /** Extra build-context files (COPY targets, scripts); `path` is relative to
   *  this service's subdir — COPY it as `<service-name>/<path>`. */
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
});

const serviceSpec = z.object({
  name: z.string(),
  /** Prebuilt image to pull. Exactly one of `image`/`build` must be set per service. */
  image: z.string().optional(),
  /** Inline build context (see `serviceBuild`) — mutually exclusive with `image`. */
  build: serviceBuild.optional(),
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
  /**
   * Structured argv, passed through as the container Cmd with NO `sh -c` wrap.
   * Wins over `command` when both are set.
   *
   * `command` is convenient but it is a SHELL string, so the container's argv
   * becomes ["sh","-c",cmd] — and an image whose entrypoint rewrites argv rather
   * than `exec "$@"` then sees the wrong thing. MinIO is the worked example: its
   * entrypoint prepends `minio` unless argv[0] already is, so a `command` turned
   * into `minio sh -c "server /data"` and the container exited with "'sh' is not
   * a minio sub-command" on every boot. There is no command string that fixes
   * that; the argv has to arrive unwrapped. Use `command` when you need a shell
   * (`a && b`), `commandArgv` when the image needs exact argv.
   */
  commandArgv: z.array(z.string()).optional(),
  /**
   * How long Docker waits after SIGTERM before SIGKILL (compose duration, e.g.
   * "10m"). The engine has always honored `advanced.stopGracePeriod`; only the
   * template could not ask for it, which silently capped every app at Docker's
   * 10s default. That is not a tuning knob for an app whose clean shutdown does
   * a final checkpoint and whose boot lease is a lockfile — being killed
   * mid-checkpoint leaves the lock behind and the next boot refuses to start.
   */
  stopGracePeriod: z.string().optional(),
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

/**
 * Every payload kind the producer registry has an implementation for, plus the
 * literal "auto" that asks it to detect one (`resolveProducerForService` in
 * packages/adapters/src/backup/registry.ts walks `detect()` in registration
 * order and falls back to "volume").
 *
 * Enumerated rather than left as a free string because a payload kind decides
 * what actually gets dumped — a typo in a catalog entry should be rejected at
 * the ingest gate, not discovered at 03:17 when the producer lookup throws with
 * nothing backed up. The cost is a real coupling: registering a NEW producer in
 * packages/adapters means adding its kind here too, or the catalog can't name it.
 * `payload_kind` in the DB stays a plain string, so nothing here needs a migration.
 */
const backupPayloadKind = z.enum([
  "auto",
  "volume",
  "pg_dump",
  "mysql_dump",
  "redis_rdb",
  "mongo_dump",
  "custom_command",
]);

/**
 * One service's authored backup default. Every field is optional because the
 * point of this block is to CORRECT a derived default, not to restate it — a
 * service that wants the derived behaviour needs no entry at all (see
 * `planAppBackupDefaults` in ./backup-defaults.ts).
 */
const backupServiceRule = z.object({
  service: z.string(),
  /** Derived defaults cover this service, but it shouldn't be backed up — a
   *  rebuildable cache, a scratch volume. Wins over every other field here. */
  skip: z.boolean().optional(),
  /**
   * Why this rule exists, for whoever reads the entry next.
   *
   * Declared rather than smuggled in as a `_comment` key because a `skip` with
   * no stated reason is indistinguishable from an oversight, and the next
   * contributor "fixes" it by deleting it. Authoring-facing today — no response
   * or view renders it yet.
   */
  reason: z.string().optional(),
  /** Omitted ⇒ "auto" (let the registry detect the producer). */
  payloadKind: backupPayloadKind.optional(),
  /** Producer-specific options, forwarded whole ({ command, exclude, ... }). */
  payloadConfig: z.record(z.string(), z.unknown()).optional(),
  /** 5-field cron. Omitted ⇒ the staggered default schedule. */
  cronExpression: z.string().optional(),
  /** Successful runs to keep. Omitted ⇒ `DEFAULT_RETAIN_COUNT`; explicit null ⇒
   *  unlimited, the same distinction `createPolicy` draws. */
  retainCount: z.number().int().positive().nullable().optional(),
  /** Age cap in days. Omitted/null ⇒ none. */
  retainDays: z.number().int().positive().nullable().optional(),
});

/**
 * What this app wants backed up, by service. Optional and additive: an app that
 * declares nothing still gets derived defaults from the volumes its services
 * already declare, so this block exists for the cases derivation gets wrong.
 */
const backup = z.object({
  services: z.array(backupServiceRule),
});

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
  backup: backup.optional(),
  available: z.boolean().optional(),
  // What the app needs from the machine, matched against the host's real capacity
  // before it installs (see `fitsCapacity`). Only what a host can be PROBED for —
  // RAM and vCPU — because a requirement we can't verify is a refusal based on a
  // guess. Absent ⇒ no preflight, which is right for almost every app.
  minResources: z
    .object({
      memoryMb: z.number().positive().optional(),
      cpuCores: z.number().positive().optional(),
    })
    .optional(),
  /**
   * Trust mark: official open-source image plus a reviewable pipeline.
   *
   * A claim about PROVENANCE, not about whether we got the app running. Booting a
   * template proves it works; it does not make its publisher vouched for. Set it
   * only when EVERY image is published by the project the app actually is, or is
   * a composition upstream itself documents (Ghost + MySQL, Supabase's own
   * compose, Convex's backend/dashboard pair).
   *
   * Leave it off when WE picked a third-party companion the upstream project
   * neither ships nor endorses — ClickHouse + ch-ui, Kafka + kafbat-ui,
   * MongoDB + mongo-express, Valkey + RedisInsight — or when the publisher is a
   * single maintainer whose build pipeline cannot be reviewed (neond).
   */
  verified: z.boolean().optional(),
  // Hidden from the browsable catalog while staying fully installable — for an app
  // reached through another app's wizard rather than the grid. NOT `available:
  // false`, which is a refusal ("app-not-available"), not a listing choice.
  unlisted: z.boolean().optional(),
  // How the app is hosted, for an honest catalog badge + wizard notice. Absent ⇒
  // "self-hosted" (the default: runs on the user's own server). "experimental" =
  // self-host that runs but isn't production-grade (heavy/unsupported). Purely
  // presentational; additive. Every catalog app is something Openship runs.
  hosting: z.enum(["self-hosted", "experimental"]).optional(),
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
  (data.backup?.services ?? []).forEach((b, i) =>
    refSvc(b.service, ["backup", "services", i, "service"], "backup rule"),
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

  // Every service must set EXACTLY ONE of image|build — a prebuilt image to pull,
  // or an inline build context to build. Neither (nothing to run) nor both
  // (ambiguous) is a template-authoring error caught at the gate.
  (data.services ?? []).forEach((s, i) => {
    const hasImage = typeof s.image === "string" && s.image.length > 0;
    const hasBuild = !!s.build;
    if (hasImage === hasBuild) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["services", i],
        message: `service "${s.name}" must set exactly one of image|build`,
      });
    }
  });

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
