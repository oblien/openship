/**
 * Docker Compose parser - extracts services, ports, volumes, depends_on,
 * and environment from a docker-compose.yml / compose.yml file.
 *
 * Used by the prepare service to populate the services UI for compose projects.
 */

import { parse as parseYaml } from "yaml";
import {
  commandToArgv,
  composeBuildIssues,
  composeMountIssues,
  composeMountToSpec,
  composePortToSpec,
  parseComposeDurationNs,
  parseComposeNamespace,
  parseContainerHosts,
  parseComposeEnvFile,
  interpolateComposeString,
  resolveComposeInterpolation,
  hasComposeInterpolation,
  resolveComposeValue,
  resolveBareEnvironmentKey,
  createComposeInterpolationDiagnostics,
  readComposeGpuConfig,
  readComposeShmConfig,
} from "@repo/core";
import type {
  ComposeAdvanced,
  ComposeHealthcheck,
  ComposeNamespaceField,
  ComposeMissingVariable,
  ComposeEnvironmentMeta,
} from "@repo/core";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Output of parsing a docker-compose.yml - the raw service rows as the YAML
 * file describes them, nothing else. If you see a field here that isn't in
 * the compose spec, it doesn't belong.
 *
 * Pipeline code that needs to handle both compose services AND monorepo
 * sub-apps should consume `DeployableService` from `./deployable-service.ts`
 * - the wider shape that adds the source-built sub-app fields on top of
 * this one. Keeping the parser type narrow stops monorepo fields from
 * leaking back into the parser's expected output.
 */
export interface ComposeService {
  name: string;
  image?: string;
  build?: string;
  dockerfile?: string;
  /** Per-service Docker build arguments from `build.args`. Kept separate from
   * runtime environment: two services may build the same Dockerfile with
   * different args, and those values must reach only their own image build. */
  buildArgs?: Record<string, string | null>;
  ports: string[];
  dependsOn: string[];
  environment: Record<string, string>;
  /**
   * Original Compose expressions, kept only until persistence converts those
   * keys back to their raw form. Never returned by service read APIs.
   */
  environmentTemplates?: Record<string, string>;
  environmentMeta?: Record<string, ComposeEnvironmentMeta>;
  volumes: string[];
  command?: string;
  /**
   * #332: structured argv for the container Cmd. list-form → verbatim;
   * string-form → shell-word-split. `null`/absent → no override (image CMD);
   * `[]` → clear image CMD. `command` above is the display/legacy string.
   */
  commandArgv?: string[] | null;
  restart?: string;
  /** Extended compose fields (healthcheck, …) not warranting a top-level key. */
  advanced?: ComposeAdvanced;
  exposed?: boolean;
  exposedPort?: string;
  domain?: string;
  customDomain?: string;
  domainType?: "free" | "custom";
}

export interface ComposeParseResult {
  services: ComposeService[];
  volumes: string[];
  networks: string[];
  /**
   * Variables the file marks mandatory (`${VAR:?msg}` / `${VAR?msg}`) that no
   * `.env` or caller value satisfied. Reported, never thrown — see
   * {@link parseComposeFile}.
   */
  missingRequired: ComposeMissingVariable[];
  /**
   * Compose keys this file declares that openship does not model. Reported, never
   * thrown (same reason as `missingRequired`): the caller decides, and a `blocking`
   * entry is the one it must refuse on rather than deploy.
   *
   * The point is that a dropped key stops being invisible. Before this, a compose
   * file asking for a namespace, a capability, or a tmpfs deployed as if it had
   * asked for none of them, and nothing anywhere said so (#533).
   */
  unsupported: ComposeUnsupportedField[];
}

/** One compose key the file declares and openship can't honor. */
export interface ComposeUnsupportedField {
  /** Service it was declared on. */
  service: string;
  /** The key as the FILE spells it (`network_mode`, `cap_add`) — what the user greps for. */
  field: string;
  /** Operator-facing explanation. Never interpolates a value that could carry a secret. */
  reason: string;
  /**
   * The caller must REFUSE the import instead of continuing.
   *
   * Reserved for the cases where proceeding deploys something materially
   * different from what the file describes, in a direction the author can't see:
   * a namespace escape (`network_mode: host`), a value we'd have to guess at, or
   * a mount whose kind would change (a tmpfs becoming a persistent disk-backed
   * volume). Everything else is a warning — the service still runs, just without
   * the extra, which is how `advanced` has always degraded.
   */
  blocking?: boolean;
}

export type {
  ComposeMissingVariable,
  ComposeEnvironmentMeta,
  ComposeInterpolationResolution,
  ComposeEnvironmentResolution,
} from "@repo/core";
export {
  parseComposeEnvFile,
  resolveComposeInterpolation,
  resolveComposeEnvironmentTemplates,
} from "@repo/core";

export interface ComposeParseOptions {
  /** Contents of project .env files used for Docker Compose interpolation. */
  envFileContent?: string | string[];
  /** Explicit interpolation values. Overrides values loaded from envFileContent. */
  env?: Record<string, string>;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a compose file. Throws ONLY when the file itself is unusable (invalid
 * YAML) — never because a variable has no value.
 *
 * A mandatory-variable operator (`${VAR:?msg}`) is a hard stop for
 * `docker compose up`, but every caller here is INSPECTING a file (import scan,
 * server migration, redeploy drift) at a point where the user hasn't supplied
 * values yet: that's the whole reason the wizard shows an env form. Throwing
 * there took the entire repo load down with "Could not parse the Docker Compose
 * file: set POSTGRES_PASSWORD in .env" (#472) and left no way forward. So an
 * unsatisfied mandatory variable resolves to "" like any other unset one, marked
 * `required` in `environmentMeta` (the wizard's "Needs value" state) and listed
 * in `missingRequired`.
 */
export function parseComposeFile(
  content: string,
  options: ComposeParseOptions = {},
): ComposeParseResult {
  // `merge: true` is required, not cosmetic: the parser defaults to YAML 1.2,
  // where `<<` is an ordinary key. Compose files that hoist shared config into
  // an anchor (`x-environment: &shared` + `<<: *shared`) otherwise lose every
  // anchored value and carry a literal "<<" key through to the container env.
  const doc = parseYaml(content, { merge: true });

  if (!doc || typeof doc !== "object") {
    return { services: [], volumes: [], networks: [], missingRequired: [], unsupported: [] };
  }

  // Keep the source-only value separate from the effective deployment value.
  // Legacy rows have no imported baseline; this is the only reliable way to
  // recognize the value an older scan stored without confusing a later manual
  // image override for parser-owned state.
  const sourceInterpolationEnv = buildInterpolationEnv({
    envFileContent: options.envFileContent,
  });
  const interpolationEnv = { ...sourceInterpolationEnv, ...(options.env ?? {}) };
  const missingRequired = createComposeInterpolationDiagnostics(interpolationEnv);
  const rawServices = doc.services ?? {};
  const services: ComposeService[] = [];
  const unsupported: ComposeUnsupportedField[] = [];

  for (const [name, def] of Object.entries(rawServices)) {
    if (!def || typeof def !== "object") continue;
    const svc = def as Record<string, unknown>;
    const build = parseBuild(svc.build, interpolationEnv);
    const environment = parseEnvironment(svc.environment, interpolationEnv);
    const rawImage = typeof svc.image === "string" ? svc.image : undefined;
    const image =
      rawImage === undefined ? undefined : resolveComposeInterpolation(rawImage, interpolationEnv);
    const sourceImage =
      rawImage === undefined
        ? undefined
        : resolveComposeInterpolation(rawImage, sourceInterpolationEnv);
    const imageTemplate =
      rawImage !== undefined && hasComposeInterpolation(rawImage)
        ? {
            expression: rawImage,
            unresolvedVariables: image!.unresolvedVariables,
            sourceValue: sourceImage!.value,
          }
        : undefined;
    const parsedAdvanced = parseAdvanced(svc, interpolationEnv, name, unsupported);
    // An empty marker is meaningful: it says this BUILD declaration came from a
    // provenance-aware parser. Stamp it even when the current `build:` block has
    // no `args` key, so removing that key clears previously stored args through
    // non-authoritative snapshot-safe sync paths. A legacy snapshot has no marker
    // and therefore still treats an omitted buildArgs field as "no opinion".
    const hasEnvironmentDeclaration = Object.hasOwn(svc, "environment");
    const hasBuildDeclaration = Object.hasOwn(svc, "build");
    const advanced: ComposeAdvanced | undefined =
      parsedAdvanced || imageTemplate || hasEnvironmentDeclaration || hasBuildDeclaration
        ? {
            ...(parsedAdvanced ?? {}),
            ...(imageTemplate && { imageTemplate }),
            ...(hasEnvironmentDeclaration && {
              environmentTemplateKeys: Object.keys(environment.templates),
            }),
            ...(hasBuildDeclaration && {
              buildArgTemplateKeys: build.templateKeys,
            }),
          }
        : undefined;
    collectUnsupported(name, svc, unsupported, interpolationEnv);

    services.push({
      name,
      image: image?.value,
      build: build.context,
      dockerfile: build.dockerfile,
      ...(build.args && { buildArgs: build.args }),
      ports: parsePorts(svc.ports, interpolationEnv),
      dependsOn: parseDependsOn(svc.depends_on),
      environment: environment.values,
      ...(Object.keys(environment.templates).length > 0 && {
        environmentTemplates: environment.templates,
      }),
      ...(Object.keys(environment.metadata).length > 0 && {
        environmentMeta: environment.metadata,
      }),
      volumes: parseVolumes(svc.volumes, interpolationEnv),
      ...parseCommand(svc.command, interpolationEnv),
      restart:
        typeof svc.restart === "string"
          ? interpolateComposeString(svc.restart, interpolationEnv)
          : undefined,
      ...(advanced && { advanced }),
    });
  }

  const volumes = doc.volumes ? Object.keys(doc.volumes) : [];
  const networks = doc.networks ? Object.keys(doc.networks) : [];

  return {
    services,
    volumes,
    networks,
    missingRequired: [...missingRequired].map(([variable, message]) => ({
      variable,
      ...(message && { message }),
    })),
    unsupported,
  };
}

/** Any entry the caller must refuse the import on. */
export function blockingComposeFields(
  unsupported: readonly ComposeUnsupportedField[],
): ComposeUnsupportedField[] {
  return unsupported.filter((u) => u.blocking);
}

/** One operator-facing message for a set of blocking entries. */
export function describeBlockingComposeFields(
  blocking: readonly ComposeUnsupportedField[],
): string {
  return blocking.map((b) => `Service "${b.service}": ${b.reason}`).join("\n");
}

// ─── Field parsers ───────────────────────────────────────────────────────────

function parseBuildArgs(
  raw: unknown,
  env: Record<string, string>,
): {
  args?: Record<string, string | null>;
  templateKeys: string[];
} {
  const args: Record<string, string | null> = {};
  const templateKeys = new Set<string>();

  const preserveValue = (key: string, value: string): string => {
    // Evaluate once only to collect `${VAR:?message}` diagnostics. Persist the
    // expression itself so the final deployment-scoped build environment—not a
    // scan-time .env preview—decides its value.
    if (value.includes("$")) {
      interpolateComposeString(value, env);
      templateKeys.add(key);
    } else {
      // List form permits duplicate keys; the last declaration wins in Compose,
      // so its provenance must win here too.
      templateKeys.delete(key);
    }
    return value;
  };

  // Compose accepts both map form (`KEY: value`) and list form
  // (`KEY=value` / bare `KEY`). A bare/null value imports from Compose's
  // invocation environment at BUILD time. Values containing Compose expressions
  // are also kept raw and resolved at build time; eagerly persisting their
  // scan-time value leaked .env values and made later env edits ineffective.
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const equals = entry.indexOf("=");
      const rawKey = equals >= 0 ? entry.slice(0, equals) : entry;
      const key = interpolateComposeString(rawKey, env).trim();
      if (!key) continue;
      if (equals >= 0) args[key] = preserveValue(key, entry.slice(equals + 1));
      else {
        args[key] = null;
        templateKeys.delete(key);
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!key) continue;
      if (value === null || value === undefined) {
        args[key] = null;
        templateKeys.delete(key);
      } else if (["string", "number", "boolean"].includes(typeof value)) {
        args[key] = preserveValue(key, String(value));
      }
    }
  }

  return {
    ...(Object.keys(args).length > 0 && { args }),
    templateKeys: [...templateKeys],
  };
}

function parseBuild(
  build: unknown,
  env: Record<string, string>,
): {
  context?: string;
  dockerfile?: string;
  args?: Record<string, string | null>;
  templateKeys: string[];
} {
  if (typeof build === "string") {
    return {
      context: interpolateComposeString(build, env),
      templateKeys: [],
    };
  }
  if (build && typeof build === "object") {
    const b = build as Record<string, unknown>;
    const parsedArgs = parseBuildArgs(b.args, env);
    return {
      context:
        (typeof b.context === "string" ? interpolateComposeString(b.context, env) : undefined) ??
        ".",
      dockerfile:
        typeof b.dockerfile === "string" ? interpolateComposeString(b.dockerfile, env) : undefined,
      args: parsedArgs.args,
      templateKeys: parsedArgs.templateKeys,
    };
  }
  return { templateKeys: [] };
}

function parsePorts(ports: unknown, env: Record<string, string>): string[] {
  if (!Array.isArray(ports)) return [];
  return ports.map((p) => {
    // String short form already carries any "/udp" suffix — keep it verbatim.
    if (typeof p === "string") return interpolateComposeString(p, env);
    if (typeof p === "number") return String(p);
    if (p && typeof p === "object") {
      // Long form → short form via the SHARED fold, so this parser and the CLI's
      // `docker compose config` reader can't disagree about it (see compose-spec.ts).
      const spec = composePortToSpec(p as Record<string, unknown>, (v) =>
        interpolateComposeString(v, env),
      );
      if (spec !== undefined) return spec;
    }
    return String(p);
  });
}

function parseDependsOn(deps: unknown): string[] {
  if (Array.isArray(deps)) return deps.filter((d): d is string => typeof d === "string");
  if (deps && typeof deps === "object") return Object.keys(deps);
  return [];
}

function parseEnvironment(
  env: unknown,
  interpolationEnv: Record<string, string>,
): {
  values: Record<string, string>;
  templates: Record<string, string>;
  metadata: Record<string, ComposeEnvironmentMeta>;
} {
  if (!env) return { values: {}, templates: {}, metadata: {} };

  // Array form: ["KEY=value", "KEY2=value2"]
  if (Array.isArray(env)) {
    const values: Record<string, string> = {};
    const templates: Record<string, string> = {};
    const metadata: Record<string, ComposeEnvironmentMeta> = {};
    for (const item of env) {
      if (typeof item !== "string") continue;
      const eqIdx = item.indexOf("=");
      if (eqIdx > 0) {
        const key = interpolateComposeString(item.slice(0, eqIdx), interpolationEnv);
        const rawValue = item.slice(eqIdx + 1);
        const resolved = resolveComposeValue(rawValue, interpolationEnv);
        values[key] = resolved.value;
        recordComposeEnvironmentTemplate(templates, key, rawValue);
        if (resolved.meta) metadata[key] = resolved.meta;
      } else {
        const key = interpolateComposeString(item, interpolationEnv);
        const resolved = resolveBareEnvironmentKey(key, interpolationEnv);
        values[key] = resolved.value;
        templates[key] = `$${key}`;
        if (resolved.meta) metadata[key] = resolved.meta;
      }
    }
    return { values, templates, metadata };
  }

  // Object form: { KEY: value }
  if (typeof env === "object") {
    const values: Record<string, string> = {};
    const templates: Record<string, string> = {};
    const metadata: Record<string, ComposeEnvironmentMeta> = {};
    for (const [key, val] of Object.entries(env as Record<string, unknown>)) {
      if (val == null) {
        const resolved = resolveBareEnvironmentKey(key, interpolationEnv);
        values[key] = resolved.value;
        templates[key] = `$${key}`;
        if (resolved.meta) metadata[key] = resolved.meta;
        continue;
      }

      const rawValue = String(val);
      const resolved = resolveComposeValue(rawValue, interpolationEnv);
      values[key] = resolved.value;
      recordComposeEnvironmentTemplate(templates, key, rawValue);
      if (resolved.meta) metadata[key] = resolved.meta;
    }
    return { values, templates, metadata };
  }

  return { values: {}, templates: {}, metadata: {} };
}

/**
 * Compose interpolation provenance for an already-parsed environment map.
 *
 * The parser and the manual services/sync boundary both use this helper so a
 * value such as `${APP_KEY}` has exactly one meaning everywhere: resolve it from
 * the deployment-scoped environment. Compose's `$$` escape remains correct —
 * `$${APP_KEY}` is recorded as a template and resolves once to the literal
 * `${APP_KEY}`. Keeping the dollar check here prevents the import parser and the
 * sync endpoint from growing two subtly different interpolation detectors.
 */
function recordComposeEnvironmentTemplate(
  templates: Record<string, string>,
  key: string,
  expression: string,
): void {
  if (expression.includes("$")) templates[key] = expression;
}

export function inferComposeEnvironmentTemplates(
  environment: Record<string, string> | null | undefined,
): Record<string, string> {
  const templates: Record<string, string> = {};
  for (const [key, expression] of Object.entries(environment ?? {})) {
    recordComposeEnvironmentTemplate(templates, key, expression);
  }
  return templates;
}

function parseVolumes(vols: unknown, env: Record<string, string>): string[] {
  if (!Array.isArray(vols)) return [];
  return vols.map((v) => {
    if (typeof v === "string") return interpolateComposeString(v, env);
    if (v && typeof v === "object") {
      // Long form → short form via the SHARED fold. The CLI's sync mapper spelled
      // this itself and dropped `read_only`, turning every declared-read-only bind
      // into a writable one; one implementation is why that can't recur (#533).
      const spec = composeMountToSpec(v as Record<string, unknown>, (s) =>
        interpolateComposeString(s, env),
      );
      if (spec !== undefined) return spec;
    }
    return String(v);
  });
}

/**
 * Parse a compose `command` into BOTH a display string and structured argv (#332).
 * docker-compose semantics: list → argv verbatim; string → shell-word-split into
 * argv (NO implicit `sh -c` — a shell needs an explicit `sh -c`); absent → no
 * override. The `command` string is kept for display / legacy compatibility.
 */
function parseCommand(
  command: unknown,
  env: Record<string, string>,
): { command?: string; commandArgv?: string[] | null } {
  if (typeof command === "string") {
    const interpolated = interpolateComposeString(command, env);
    return { command: interpolated, commandArgv: commandToArgv(interpolated) };
  }
  if (Array.isArray(command)) {
    const argv = command.map((part) => interpolateComposeString(String(part), env));
    return { command: argv.join(" "), commandArgv: argv };
  }
  return {};
}

/**
 * Interpolate a compose `entrypoint` in place, keeping its SHAPE so `commandToArgv`
 * can still tell a string from a list from an absent key.
 *
 * Separate from `parseCommand`, which folds both shapes into a display string plus
 * argv; here the shape carries meaning all the way through — `""` and `[]` are both
 * "clear it" but `undefined` is not, and collapsing them early is what lost the
 * distinction in the first place.
 */
function parseEntrypointValue(
  value: unknown,
  env: Record<string, string>,
): string | string[] | null | undefined {
  if (typeof value === "string") return interpolateComposeString(value, env);
  if (Array.isArray(value)) {
    return value.map((part) => interpolateComposeString(String(part), env));
  }
  // Anything else (a number, an object, an explicit null) is not an entrypoint —
  // hand back undefined so `commandToArgv` reports "absent" and the key is omitted.
  return undefined;
}

/**
 * Extract the extended compose keys that live under `service.advanced`. Returns
 * undefined when nothing was found so callers can omit the field entirely (keeps
 * it out of drift comparisons and the runtime payload). Grows as more keys are
 * supported.
 */
function parseAdvanced(
  svc: Record<string, unknown>,
  env: Record<string, string>,
  serviceName: string,
  unsupported: ComposeUnsupportedField[],
): ComposeAdvanced | undefined {
  const advanced: ComposeAdvanced = {};

  const healthcheck = parseHealthcheck(svc.healthcheck, env);
  if (healthcheck) advanced.healthcheck = healthcheck;

  const resources = parseServiceResources(svc, env);
  if (resources) advanced.resources = resources;

  const gpu = readComposeGpuConfig(svc, (value) => interpolateComposeString(value, env));
  Object.assign(advanced, gpu.config);
  unsupported.push(...gpu.issues.map((issue) => ({ service: serviceName, ...issue })));
  const shm = readComposeShmConfig(svc.shm_size, (value) => interpolateComposeString(value, env));
  Object.assign(advanced, shm.config);
  unsupported.push(...shm.issues.map((issue) => ({ service: serviceName, ...issue })));

  const networkMode = parseNamespaceField(
    svc.network_mode,
    "network_mode",
    env,
    serviceName,
    unsupported,
  );
  if (networkMode) advanced.networkMode = networkMode;

  const pidMode = parseNamespaceField(svc.pid, "pid", env, serviceName, unsupported);
  if (pidMode) advanced.pidMode = pidMode;
  const extraHosts = parseContainerHosts(svc.extra_hosts, (value) => interpolateComposeString(value, env));
  if (extraHosts !== undefined) advanced.extraHosts = extraHosts;

  // Entrypoint (#575), on exactly the terms `parseCommand` uses for `command`:
  // list → argv verbatim, string → shell-word-split (no implicit `sh -c`).
  //
  // The `!== null` test rather than a truthiness one is the whole point:
  // `commandToArgv` answers `null` for an ABSENT key and `[]` for `entrypoint: []`
  // or `entrypoint: ""`, and those two mean opposite things — leave the image's
  // ENTRYPOINT alone versus clear it. Storing `[]` is what makes the clearing form
  // work at all; it used to be dropped without even a warning.
  const entrypoint = commandToArgv(parseEntrypointValue(svc.entrypoint, env));
  if (entrypoint !== null) advanced.entrypoint = entrypoint;

  // Shutdown behavior. Both are kept as authored strings — the runtime maps
  // stop_signal → StopSignal verbatim and rounds stop_grace_period to the whole
  // seconds Docker's StopTimeout expects.
  const rawSignal = svc.stop_signal;
  if (typeof rawSignal === "string") {
    const signal = interpolateComposeString(rawSignal, env).trim();
    if (signal) advanced.stopSignal = signal;
  }
  const rawGrace = svc.stop_grace_period;
  const grace =
    typeof rawGrace === "string"
      ? interpolateComposeString(rawGrace, env).trim()
      : typeof rawGrace === "number"
        ? String(rawGrace)
        : undefined;
  if (grace) advanced.stopGracePeriod = grace;

  // The runtime applies a duration it can't read as unset, so Docker's default
  // takes over: 10 seconds for a grace period meant to be longer. Say so at
  // parse time instead of letting the first stop discover it.
  const durations = [
    ["stop_grace_period", advanced.stopGracePeriod],
    ["healthcheck.interval", advanced.healthcheck?.interval],
    ["healthcheck.timeout", advanced.healthcheck?.timeout],
    ["healthcheck.start_period", advanced.healthcheck?.startPeriod],
  ] as const;
  for (const [field, value] of durations) {
    if (value === undefined || parseComposeDurationNs(value) !== undefined) continue;
    unsupported.push({
      service: serviceName,
      field,
      reason:
        `${field} is not a duration like "90s" or "1m30s", so it is ignored and ` +
        `Docker's default applies.`,
    });
  }

  return Object.keys(advanced).length > 0 ? advanced : undefined;
}

/**
 * Validate one namespace key and report it when it can't be honored.
 *
 * A rejection is BLOCKING on purpose. Every other unsupported key degrades to
 * "runs without the extra"; a namespace does not — a service the author confined
 * to a VPN sidecar's netns, deployed with its own interface instead, egresses in
 * the clear while looking healthy. Refusing the import is the only outcome that
 * doesn't quietly change what the file asked for. See compose-namespace.ts.
 */
function parseNamespaceField(
  raw: unknown,
  field: ComposeNamespaceField,
  env: Record<string, string>,
  serviceName: string,
  unsupported: ComposeUnsupportedField[],
): string | undefined {
  const interpolated = typeof raw === "string" ? interpolateComposeString(raw, env) : raw;
  const parsed = parseComposeNamespace(interpolated, field);
  if (!parsed) return undefined;
  if (!parsed.ok) {
    unsupported.push({ service: serviceName, field, reason: parsed.reason, blocking: true });
    return undefined;
  }
  return parsed.value;
}

/**
 * Compose keys openship does not model, so the wizard can say so instead of the
 * file quietly deploying as something else.
 *
 * Grouped by what the omission costs, because that is what decides `blocking`:
 * the privilege/namespace/runtime-shape keys leave a service running with less
 * than it asked for (a warning), while a mount whose KIND would change is a
 * different workload than the file describes (blocking, handled separately in
 * {@link collectUnsupportedMounts}).
 */
const UNSUPPORTED_SERVICE_KEYS: Record<string, string> = {
  // ── Host privilege + namespaces ──
  privileged: "privileged is not modeled — the container runs unprivileged.",
  cap_add: "cap_add is not modeled — no extra capabilities are granted.",
  cap_drop: "cap_drop is not modeled — the default capability set is kept.",
  devices: "devices is not modeled — no host devices are passed through.",
  device_cgroup_rules: "device_cgroup_rules is not modeled.",
  security_opt: "security_opt is not modeled — default seccomp/AppArmor apply.",
  sysctls: "sysctls is not modeled — kernel parameters stay at their defaults.",
  ulimits: "ulimits is not modeled — daemon defaults apply.",
  ipc: "ipc is not modeled — the container gets its own IPC namespace.",
  userns_mode: "userns_mode is not modeled.",
  uts: "uts is not modeled.",
  cgroup: "cgroup is not modeled.",
  cgroup_parent: "cgroup_parent is not modeled.",
  group_add: "group_add is not modeled.",
  pids_limit: "pids_limit is not modeled.",
  oom_kill_disable: "oom_kill_disable is not modeled.",
  oom_score_adj: "oom_score_adj is not modeled.",
  runtime: "runtime is not modeled — the daemon's default runtime is used.",
  isolation: "isolation is not modeled.",
  storage_opt: "storage_opt is not modeled.",
  blkio_config: "blkio_config is not modeled.",
  // ── Container shape ──
  // `entrypoint` is modeled (#575) — see parseAdvanced.
  user: "user is not modeled — the container runs as the image's user.",
  working_dir: "working_dir is not modeled — the image's WORKDIR is used.",
  hostname: "hostname is not modeled — Openship sets the hostname to the service name.",
  domainname: "domainname is not modeled.",
  mac_address: "mac_address is not modeled.",
  platform: "platform is not modeled — the image is pulled for the host's architecture.",
  init: "init is not modeled — no init process is injected.",
  read_only: "read_only (root filesystem) is not modeled — the root filesystem stays writable.",
  tmpfs: "tmpfs is not modeled — no in-memory filesystem is mounted.",
  // ── Networking ──
  dns: "dns is not modeled — the container uses the Docker network's resolver.",
  dns_search: "dns_search is not modeled.",
  dns_opt: "dns_opt is not modeled.",
  extra_hosts: "extra_hosts is not modeled — services resolve each other by service name.",
  links: "links is legacy and not modeled — services already resolve by service name.",
  external_links: "external_links is not modeled — link the app as a service connection instead.",
  expose: "expose is not modeled — every service is reachable by name on the project network.",
  // ── Compose model ──
  configs: "configs is not modeled — use a bind-mounted file instead.",
  secrets: "secrets is not modeled — use environment variables instead.",
  volumes_from: "volumes_from is legacy and not modeled — declare the volume on both services.",
  profiles: "profiles is not modeled — every service in the file is imported.",
  labels: "labels is not modeled — Openship sets its own container labels.",
  logging: "logging is not modeled — the daemon's default log driver is used.",
};

/**
 * Did the file actually ASK for something here, or just write down the default?
 *
 * `privileged: false`, `init: false`, `pids_limit: 0`, `cap_add: []` all name a key
 * we don't model while requesting exactly the behaviour the container already gets.
 * Reporting those is worse than saying nothing: it teaches the operator to skim a
 * list that includes items where nothing was lost, and the one line that DID matter
 * is in the same list.
 */
function requestsSomething(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function isNvidiaRuntime(value: unknown, env: Record<string, string>): boolean {
  if (typeof value !== "string") return false;
  return interpolateComposeString(value, env).trim().toLowerCase() === "nvidia";
}

function collectUnsupported(
  serviceName: string,
  svc: Record<string, unknown>,
  unsupported: ComposeUnsupportedField[],
  env: Record<string, string>,
): void {
  for (const [key, reason] of Object.entries(UNSUPPORTED_SERVICE_KEYS)) {
    if (!requestsSomething(svc[key])) continue;
    // `runtime: nvidia` is retained as HostConfig.Runtime. Any other runtime
    // (`runsc`, `kata`, ...) still falls back to the daemon default and is reported.
    if (key === "runtime" && isNvidiaRuntime(svc[key], env)) continue;
    // `gpus` is modeled (readComposeGpuConfig) and is not in this table; nothing to skip here.
    unsupported.push({ service: serviceName, field: key, reason });
  }

  // `deploy:` carries one key we DO honor (resources.limits, see
  // parseServiceResources) — report only the rest, and only when present, so a
  // file that just sets a memory cap doesn't get told `deploy` was dropped.
  const deploy = svc.deploy as Record<string, unknown> | undefined;
  if (deploy && typeof deploy === "object") {
    const modeled = new Set(["resources"]);
    const rest = Object.keys(deploy).filter((k) => !modeled.has(k));
    if (rest.length > 0) {
      unsupported.push({
        service: serviceName,
        field: "deploy",
        reason:
          `deploy.${rest.join("/")} is not modeled — Openship runs one container per ` +
          `service (only deploy.resources.limits and the GPU in deploy.resources.reservations.devices are honored).`,
      });
    }
  }

  // A service pinned to named networks: openship puts every service on ONE
  // project network, so the topology flattens. They still resolve each other by
  // name, which is why this is a warning rather than a refusal.
  const networks = svc.networks;
  const networkNames = Array.isArray(networks)
    ? networks.filter((n): n is string => typeof n === "string")
    : networks && typeof networks === "object"
      ? Object.keys(networks)
      : [];
  if (networkNames.length > 0) {
    unsupported.push({
      service: serviceName,
      field: "networks",
      reason:
        `networks (${networkNames.join(", ")}) is flattened — every service joins the ` +
        `one project network and still resolves the others by service name.`,
    });
  }

  for (const issue of composeBuildIssues(svc.build, {
    interpolate: (value) => interpolateComposeString(value, env),
  })) {
    unsupported.push({ service: serviceName, ...issue });
  }

  collectUnsupportedMounts(serviceName, svc.volumes, unsupported);
}

/** Long-form mount options {@link parseVolumes} can't fold into a bind spec. The
 *  rules live in @repo/core so the CLI's sync mapper enforces the identical set —
 *  a file the API refuses must not be accepted by `openship service sync`. */
function collectUnsupportedMounts(
  serviceName: string,
  vols: unknown,
  unsupported: ComposeUnsupportedField[],
): void {
  if (!Array.isArray(vols)) return;
  for (const v of vols) {
    if (!v || typeof v !== "object") continue;
    for (const issue of composeMountIssues(v as Record<string, unknown>)) {
      unsupported.push({ service: serviceName, ...issue });
    }
  }
}

/**
 * Compose memory string → MB. Accepts the byte-suffix forms compose allows
 * (`512m`, `2g`, `1024k`, `1073741824`) plus the `2gb`/`512mb` spellings people
 * actually write. Returns undefined for anything unparseable — a malformed
 * limit must not silently become a tiny cap.
 */
function parseComposeMemory(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    // Bare numbers are bytes. Match the string path: flooring a sub-MB
    // value to zero would turn an invalid limit into explicit unlimited.
    const mb = raw / (1024 * 1024);
    return Number.isFinite(mb) && mb >= 1 ? Math.floor(mb) : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const m = raw
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/);
  if (!m) return undefined;
  const value = parseFloat(m[1]!);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const factor: Record<string, number> = {
    "": 1 / (1024 * 1024), // bytes → MB
    k: 1 / 1024,
    m: 1,
    g: 1024,
    t: 1024 * 1024,
  };
  const mb = value * (factor[m[2]!] ?? 1);
  return Number.isFinite(mb) && mb >= 1 ? Math.floor(mb) : undefined;
}

/** Compose cpu string/number → fractional cores ("0.5", 2, "1.5"). */
function parseComposeCpus(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Normalize a service's own resource limits. Compose has two spellings and we
 * honor both, with the swarm `deploy.resources.limits` block winning because
 * it's the more specific/modern form when a file carries both.
 */
function parseServiceResources(
  svc: Record<string, unknown>,
  env: Record<string, string>,
): { cpuCores?: number; memoryMb?: number } | undefined {
  const interp = (v: unknown) => (typeof v === "string" ? interpolateComposeString(v, env) : v);

  let memoryMb = parseComposeMemory(interp(svc.mem_limit));
  let cpuCores = parseComposeCpus(interp(svc.cpus));

  const limits = (
    (svc.deploy as Record<string, unknown> | undefined)?.resources as
      | Record<string, unknown>
      | undefined
  )?.limits as Record<string, unknown> | undefined;
  if (limits) {
    memoryMb = parseComposeMemory(interp(limits.memory)) ?? memoryMb;
    cpuCores = parseComposeCpus(interp(limits.cpus)) ?? cpuCores;
  }

  if (memoryMb === undefined && cpuCores === undefined) return undefined;
  return {
    ...(cpuCores !== undefined && { cpuCores }),
    ...(memoryMb !== undefined && { memoryMb }),
  };
}

/**
 * Normalize a compose `healthcheck` block. The `test` field is reduced to the
 * form the runtime re-wraps: a shell string (compose `test: "…"` or the
 * `CMD-SHELL` array form) or an argv array (the `CMD` array form). `["NONE"]`
 * and `disable: true` both collapse to `disable`. Durations are kept as compose
 * strings ("30s") — the runtime converts to nanoseconds at create time.
 */
function parseHealthcheck(
  hc: unknown,
  env: Record<string, string>,
): ComposeHealthcheck | undefined {
  if (!hc || typeof hc !== "object") return undefined;
  const h = hc as Record<string, unknown>;
  const result: ComposeHealthcheck = {};

  if (h.disable === true) result.disable = true;

  const rawTest = h.test;
  if (typeof rawTest === "string") {
    result.test = interpolateComposeString(rawTest, env);
  } else if (Array.isArray(rawTest)) {
    const parts = rawTest.map((p) => interpolateComposeString(String(p), env));
    const head = parts[0];
    if (head === "NONE") {
      result.disable = true;
    } else if (head === "CMD-SHELL") {
      result.test = parts.slice(1).join(" ");
    } else if (head === "CMD") {
      result.test = parts.slice(1);
    } else {
      result.test = parts;
    }
  }

  const dur = (v: unknown): string | undefined =>
    typeof v === "string"
      ? interpolateComposeString(v, env)
      : typeof v === "number"
        ? String(v)
        : undefined;

  const interval = dur(h.interval);
  if (interval) result.interval = interval;
  const timeout = dur(h.timeout);
  if (timeout) result.timeout = timeout;
  const startPeriod = dur(h.start_period);
  if (startPeriod) result.startPeriod = startPeriod;

  if (typeof h.retries === "number" && Number.isInteger(h.retries) && h.retries >= 0) {
    result.retries = h.retries;
  } else if (typeof h.retries === "string") {
    const n = Number(interpolateComposeString(h.retries, env));
    if (Number.isInteger(n) && n >= 0) result.retries = n;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// ─── Docker Compose interpolation ────────────────────────────────────────────

function buildInterpolationEnv(options: ComposeParseOptions): Record<string, string> {
  const env: Record<string, string> = {};
  const contents = Array.isArray(options.envFileContent)
    ? options.envFileContent
    : options.envFileContent
      ? [options.envFileContent]
      : [];

  for (const content of contents) {
    Object.assign(env, parseComposeEnvFile(content));
  }

  return { ...env, ...(options.env ?? {}) };
}
