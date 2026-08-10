/**
 * Docker Compose parser - extracts services, ports, volumes, depends_on,
 * and environment from a docker-compose.yml / compose.yml file.
 *
 * Used by the prepare service to populate the services UI for compose projects.
 */

import { parse as parseYaml } from "yaml";
import { commandToArgv } from "@repo/core";
import type { ComposeAdvanced, ComposeHealthcheck } from "@repo/core";

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
  ports: string[];
  dependsOn: string[];
  environment: Record<string, string>;
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
}

/** A mandatory compose variable with no value yet. */
export interface ComposeMissingVariable {
  variable: string;
  /** The author's own word after `:?`, VERBATIM — never interpolated, so a
   *  nested `${SECRET}` in the message can't ride out through a scan response. */
  message?: string;
}

export interface ComposeEnvironmentMeta {
  source: "env-file" | "default" | "missing" | "interpolated";
  variable?: string;
  defaultValue?: string;
  resolvedValue: string;
  expression?: string;
  /** The file declares this one mandatory (`:?` / `?`). Only set when it also
   *  came back unresolved, i.e. alongside `source: "missing"`. */
  required?: boolean;
}

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
export function parseComposeFile(content: string, options: ComposeParseOptions = {}): ComposeParseResult {
  // `merge: true` is required, not cosmetic: the parser defaults to YAML 1.2,
  // where `<<` is an ordinary key. Compose files that hoist shared config into
  // an anchor (`x-environment: &shared` + `<<: *shared`) otherwise lose every
  // anchored value and carry a literal "<<" key through to the container env.
  const doc = parseYaml(content, { merge: true });

  if (!doc || typeof doc !== "object") {
    return { services: [], volumes: [], networks: [], missingRequired: [] };
  }

  const interpolationEnv = buildInterpolationEnv(options);
  const missingRequired = new Map<string, string | undefined>();
  missingRequiredSinks.set(interpolationEnv, missingRequired);
  const rawServices = doc.services ?? {};
  const services: ComposeService[] = [];

  for (const [name, def] of Object.entries(rawServices)) {
    if (!def || typeof def !== "object") continue;
    const svc = def as Record<string, unknown>;
    const build = parseBuild(svc.build, interpolationEnv);
    const environment = parseEnvironment(svc.environment, interpolationEnv);
    const advanced = parseAdvanced(svc, interpolationEnv);

    services.push({
      name,
      image: typeof svc.image === "string" ? interpolateComposeString(svc.image, interpolationEnv) : undefined,
      build: build.context,
      dockerfile: build.dockerfile,
      ports: parsePorts(svc.ports, interpolationEnv),
      dependsOn: parseDependsOn(svc.depends_on),
      environment: environment.values,
      ...(Object.keys(environment.metadata).length > 0 && { environmentMeta: environment.metadata }),
      volumes: parseVolumes(svc.volumes, interpolationEnv),
      ...parseCommand(svc.command, interpolationEnv),
      restart: typeof svc.restart === "string" ? interpolateComposeString(svc.restart, interpolationEnv) : undefined,
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
  };
}

/**
 * Where {@link resolveInterpolationExpression} reports unsatisfied mandatory
 * variables. Keyed by the interpolation env object of the parse that's running,
 * so a sink is scoped to one `parseComposeFile` call and there is no global state
 * to reset — a resolver reached with any other env record (`.env` self-expansion
 * in `parseComposeEnvFile`) simply has nowhere to report, which is fine.
 */
const missingRequiredSinks = new WeakMap<Record<string, string>, Map<string, string | undefined>>();

function reportMissingRequired(
  key: string,
  rawWord: string,
  env: Record<string, string>,
): { value: string; source: "missing"; variable: string; required: true } {
  const sink = missingRequiredSinks.get(env);
  // First mention wins: the same variable is often required in several services
  // and the first message is as good as the last.
  if (sink && !sink.has(key)) sink.set(key, rawWord.trim() || undefined);
  return { value: "", source: "missing", variable: key, required: true };
}

// ─── Field parsers ───────────────────────────────────────────────────────────

function parseBuild(build: unknown, env: Record<string, string>): { context?: string; dockerfile?: string } {
  if (typeof build === "string") return { context: interpolateComposeString(build, env) };
  if (build && typeof build === "object") {
    const b = build as Record<string, unknown>;
    return {
      context: (typeof b.context === "string" ? interpolateComposeString(b.context, env) : undefined) ?? ".",
      dockerfile: typeof b.dockerfile === "string" ? interpolateComposeString(b.dockerfile, env) : undefined,
    };
  }
  return {};
}

function parsePorts(ports: unknown, env: Record<string, string>): string[] {
  if (!Array.isArray(ports)) return [];
  return ports.map((p) => {
    // String short form already carries any "/udp" suffix — keep it verbatim.
    if (typeof p === "string") return interpolateComposeString(p, env);
    if (typeof p === "number") return String(p);
    if (p && typeof p === "object") {
      const port = p as Record<string, unknown>;
      const target = port.target ?? port.container_port;
      const published = port.published ?? port.host_port;
      // Long form carries protocol as a separate `protocol: tcp|udp` field;
      // fold it back into the "/proto" suffix so the string form is lossless.
      const proto = typeof port.protocol === "string" ? port.protocol.toLowerCase() : undefined;
      const suffix = proto && proto !== "tcp" ? `/${proto}` : "";
      // Long form carries the bind interface as a separate `host_ip` field;
      // fold it back into the leading "<ip>:" segment the short form spells.
      const hostIp =
        typeof port.host_ip === "string" ? interpolateComposeString(port.host_ip, env) : undefined;
      if (target) {
        const hostPart = published
          ? hostIp
            ? `${hostIp}:${published}:`
            : `${published}:`
          : hostIp
            ? `${hostIp}::`
            : "";
        return `${hostPart}${target}${suffix}`;
      }
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
): { values: Record<string, string>; metadata: Record<string, ComposeEnvironmentMeta> } {
  if (!env) return { values: {}, metadata: {} };

  // Array form: ["KEY=value", "KEY2=value2"]
  if (Array.isArray(env)) {
    const values: Record<string, string> = {};
    const metadata: Record<string, ComposeEnvironmentMeta> = {};
    for (const item of env) {
      if (typeof item !== "string") continue;
      const eqIdx = item.indexOf("=");
      if (eqIdx > 0) {
        const key = interpolateComposeString(item.slice(0, eqIdx), interpolationEnv);
        const rawValue = item.slice(eqIdx + 1);
        const resolved = resolveComposeValue(rawValue, interpolationEnv);
        values[key] = resolved.value;
        if (resolved.meta) metadata[key] = resolved.meta;
      } else {
        const key = interpolateComposeString(item, interpolationEnv);
        const resolved = resolveBareEnvironmentKey(key, interpolationEnv);
        values[key] = resolved.value;
        if (resolved.meta) metadata[key] = resolved.meta;
      }
    }
    return { values, metadata };
  }

  // Object form: { KEY: value }
  if (typeof env === "object") {
    const values: Record<string, string> = {};
    const metadata: Record<string, ComposeEnvironmentMeta> = {};
    for (const [key, val] of Object.entries(env as Record<string, unknown>)) {
      if (val == null) {
        const resolved = resolveBareEnvironmentKey(key, interpolationEnv);
        values[key] = resolved.value;
        if (resolved.meta) metadata[key] = resolved.meta;
        continue;
      }

      const resolved = resolveComposeValue(String(val), interpolationEnv);
      values[key] = resolved.value;
      if (resolved.meta) metadata[key] = resolved.meta;
    }
    return { values, metadata };
  }

  return { values: {}, metadata: {} };
}

function parseVolumes(vols: unknown, env: Record<string, string>): string[] {
  if (!Array.isArray(vols)) return [];
  return vols.map((v) => {
    if (typeof v === "string") return interpolateComposeString(v, env);
    if (v && typeof v === "object") {
      const vol = v as Record<string, unknown>;
      const src = vol.source ?? vol.name;
      const tgt = vol.target;
      // Long form carries read-only/selinux/nocopy intent as separate nested
      // fields; fold them back into the single mode suffix the short-form
      // string spells (the downstream MODE_SUFFIX regex in volume-namespace.ts
      // only matches ONE flag, no combining — so read_only wins when more than
      // one is set, since silently granting write access is the worse miss).
      const bindOpts = vol.bind as Record<string, unknown> | undefined;
      const volumeOpts = vol.volume as Record<string, unknown> | undefined;
      const selinux = typeof bindOpts?.selinux === "string" ? bindOpts.selinux : undefined;
      const mode =
        vol.read_only === true
          ? ":ro"
          : volumeOpts?.nocopy === true
            ? ":nocopy"
            : selinux === "z" || selinux === "Z"
              ? `:${selinux}`
              : "";
      if (src && tgt) return `${src}:${tgt}${mode}`;
      if (tgt) return String(tgt);
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
 * Extract the extended compose keys that live under `service.advanced`. Returns
 * undefined when nothing was found so callers can omit the field entirely (keeps
 * it out of drift comparisons and the runtime payload). Grows as more keys are
 * supported; for A1 only `healthcheck` is read.
 */
function parseAdvanced(svc: Record<string, unknown>, env: Record<string, string>): ComposeAdvanced | undefined {
  const advanced: ComposeAdvanced = {};

  const healthcheck = parseHealthcheck(svc.healthcheck, env);
  if (healthcheck) advanced.healthcheck = healthcheck;

  const resources = parseServiceResources(svc, env);
  if (resources) advanced.resources = resources;

  return Object.keys(advanced).length > 0 ? advanced : undefined;
}

/**
 * Compose memory string → MB. Accepts the byte-suffix forms compose allows
 * (`512m`, `2g`, `1024k`, `1073741824`) plus the `2gb`/`512mb` spellings people
 * actually write. Returns undefined for anything unparseable — a malformed
 * limit must not silently become a tiny cap.
 */
function parseComposeMemory(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    // Bare number = bytes (compose treats an unsuffixed value as bytes).
    return raw > 0 ? Math.floor(raw / (1024 * 1024)) : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/);
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
  return mb >= 1 ? Math.floor(mb) : undefined;
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
  const interp = (v: unknown) =>
    typeof v === "string" ? interpolateComposeString(v, env) : v;

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
function parseHealthcheck(hc: unknown, env: Record<string, string>): ComposeHealthcheck | undefined {
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
    typeof v === "string" ? interpolateComposeString(v, env) : typeof v === "number" ? String(v) : undefined;

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

export function parseComposeEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const literalKeys = new Set<string>();

  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();

    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let rawValue = line.slice(eqIdx + 1);
    const continued = joinQuotedContinuation(rawValue, lines, i);
    if (continued) {
      rawValue = continued.value;
      i = continued.endLine;
    }

    const parsed = parseEnvValue(rawValue);
    result[key] = parsed.value;
    if (parsed.expand) literalKeys.delete(key);
    else literalKeys.add(key);
  }

  for (const [key, value] of Object.entries(result)) {
    if (literalKeys.has(key)) continue;
    result[key] = interpolateComposeString(value, result);
  }

  return result;
}

function joinQuotedContinuation(
  rawValue: string,
  lines: string[],
  start: number,
): { value: string; endLine: number } | undefined {
  const value = rawValue.trimStart();
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return undefined;
  if (findClosingQuote(value, quote) >= 0) return undefined;

  let joined = value;
  for (let i = start + 1; i < lines.length; i++) {
    joined += `\n${lines[i]}`;
    if (findClosingQuote(joined, quote) >= 0) return { value: joined, endLine: i };
  }

  return undefined;
}

function parseEnvValue(rawValue: string): { value: string; expand: boolean } {
  const value = rawValue.trimStart();
  if (!value) return { value: "", expand: true };

  if (value.startsWith('"')) {
    const end = findClosingQuote(value, '"');
    const quoted = end >= 0 ? value.slice(1, end) : value.slice(1);
    return {
      value: quoted.replace(/\\([nrt"\\])/g, (_m, ch: string) =>
        ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : ch,
      ),
      expand: true,
    };
  }

  if (value.startsWith("'")) {
    const end = findClosingQuote(value, "'");
    return { value: end >= 0 ? value.slice(1, end) : value.slice(1), expand: false };
  }

  const commentMatch = value.match(/\s+#/);
  const bare = commentMatch?.index === undefined ? value : value.slice(0, commentMatch.index);
  return { value: bare.trimEnd(), expand: true };
}

function findClosingQuote(value: string, quote: '"' | "'"): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === quote && value[i - 1] !== "\\") return i;
  }
  return -1;
}

const BARE_VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Reads the `${...}` expression opening at `start`, counting nested `${` so the
 * matching close brace is found. Returns null when the expression is never closed.
 */
function readBracedExpression(
  input: string,
  start: number,
): { expression: string; end: number } | null {
  let depth = 1;
  for (let i = start + 2; i < input.length; i++) {
    if (input[i] === "$" && input[i + 1] === "{") {
      depth++;
      i++;
    } else if (input[i] === "}" && --depth === 0) {
      return { expression: input.slice(start + 2, i), end: i + 1 };
    }
  }
  return null;
}

function interpolateComposeString(input: string, env: Record<string, string>): string {
  const escapedDollar = "\0COMPOSE_ESCAPED_DOLLAR\0";
  const protectedInput = input.replace(/\$\$/g, escapedDollar);

  let out = "";
  let cursor = 0;
  while (cursor < protectedInput.length) {
    const dollar = protectedInput.indexOf("$", cursor);
    if (dollar < 0) break;
    out += protectedInput.slice(cursor, dollar);
    cursor = dollar + 1;

    if (protectedInput[dollar + 1] === "{") {
      const braced = readBracedExpression(protectedInput, dollar);
      if (braced && braced.expression) {
        out += resolveInterpolationExpression(braced.expression, env).value;
        cursor = braced.end;
        continue;
      }
    } else {
      const bare = protectedInput.slice(dollar + 1).match(BARE_VARIABLE_RE);
      if (bare) {
        out += env[bare[0]] ?? "";
        cursor = dollar + 1 + bare[0].length;
        continue;
      }
    }

    out += "$";
  }

  return (out + protectedInput.slice(cursor)).replaceAll(escapedDollar, "$");
}

function resolveComposeValue(
  input: string,
  env: Record<string, string>,
): { value: string; meta?: ComposeEnvironmentMeta } {
  const trimmed = input.trim();
  const directBraced = trimmed.startsWith("${") ? readBracedExpression(trimmed, 0) : null;
  if (directBraced?.expression && directBraced.end === trimmed.length) {
    const resolved = resolveInterpolationExpression(directBraced.expression, env);
    return {
      value: resolved.value,
      meta: {
        source: resolved.source,
        variable: resolved.variable,
        defaultValue: resolved.defaultValue,
        resolvedValue: resolved.value,
        expression: trimmed,
        ...(resolved.required && { required: true }),
      },
    };
  }

  const directPlain = trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (directPlain) {
    const key = directPlain[1]!;
    const resolved = resolveBareEnvironmentKey(key, env);
    return {
      value: resolved.value,
      meta: {
        source: resolved.meta?.source ?? "missing",
        variable: key,
        resolvedValue: resolved.value,
        expression: trimmed,
      },
    };
  }

  const value = interpolateComposeString(input, env);
  if (!input.includes("$")) return { value };

  return {
    value,
    meta: {
      source: "interpolated",
      resolvedValue: value,
      expression: input,
    },
  };
}

function resolveBareEnvironmentKey(
  key: string,
  env: Record<string, string>,
): { value: string; meta: ComposeEnvironmentMeta } {
  const hasValue = Object.prototype.hasOwnProperty.call(env, key);
  const value = env[key] ?? "";
  return {
    value,
    meta: {
      source: hasValue ? "env-file" : "missing",
      variable: key,
      resolvedValue: value,
      expression: key,
    },
  };
}

function resolveInterpolationExpression(
  expression: string,
  env: Record<string, string>,
): {
  value: string;
  source: ComposeEnvironmentMeta["source"];
  variable?: string;
  defaultValue?: string;
  required?: boolean;
} {
  const match = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])(.*))?$/s);
  if (!match) return { value: "", source: "missing" };

  const [, key, operator, rawWord = ""] = match;
  const hasValue = Object.prototype.hasOwnProperty.call(env, key);
  const value = env[key] ?? "";
  const isNonEmpty = hasValue && value !== "";
  const word = () => interpolateComposeString(rawWord, env);

  switch (operator) {
    case undefined:
      return { value: hasValue ? value : "", source: hasValue ? "env-file" : "missing", variable: key };
    case ":-":
      if (isNonEmpty) return { value, source: "env-file", variable: key };
      {
        const fallback = word();
        return { value: fallback, source: "default", variable: key, defaultValue: fallback };
      }
    case "-":
      if (hasValue) return { value, source: "env-file", variable: key };
      {
        const fallback = word();
        return { value: fallback, source: "default", variable: key, defaultValue: fallback };
      }
    case ":?":
      if (isNonEmpty) return { value, source: "env-file", variable: key };
      return reportMissingRequired(key, rawWord, env);
    case "?":
      if (hasValue) return { value, source: "env-file", variable: key };
      return reportMissingRequired(key, rawWord, env);
    case ":+":
      if (!isNonEmpty) return { value: "", source: "missing", variable: key };
      {
        const replacement = word();
        return { value: replacement, source: "default", variable: key, defaultValue: replacement };
      }
    case "+":
      if (!hasValue) return { value: "", source: "missing", variable: key };
      {
        const replacement = word();
        return { value: replacement, source: "default", variable: key, defaultValue: replacement };
      }
    default:
      return { value: "", source: "missing", variable: key };
  }
}
