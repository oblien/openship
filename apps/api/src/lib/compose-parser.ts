/**
 * Docker Compose parser - extracts services, ports, volumes, depends_on,
 * and environment from a docker-compose.yml / compose.yml file.
 *
 * Used by the prepare service to populate the services UI for compose projects.
 */

import { parse as parseYaml } from "yaml";
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
}

export interface ComposeEnvironmentMeta {
  source: "env-file" | "default" | "missing" | "interpolated";
  variable?: string;
  defaultValue?: string;
  resolvedValue: string;
  expression?: string;
}

export interface ComposeParseOptions {
  /** Contents of project .env files used for Docker Compose interpolation. */
  envFileContent?: string | string[];
  /** Explicit interpolation values. Overrides values loaded from envFileContent. */
  env?: Record<string, string>;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export function parseComposeFile(content: string, options: ComposeParseOptions = {}): ComposeParseResult {
  const doc = parseYaml(content);

  if (!doc || typeof doc !== "object") {
    return { services: [], volumes: [], networks: [] };
  }

  const interpolationEnv = buildInterpolationEnv(options);
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
      command: parseCommand(svc.command, interpolationEnv),
      restart: typeof svc.restart === "string" ? interpolateComposeString(svc.restart, interpolationEnv) : undefined,
      ...(advanced && { advanced }),
    });
  }

  const volumes = doc.volumes ? Object.keys(doc.volumes) : [];
  const networks = doc.networks ? Object.keys(doc.networks) : [];

  return { services, volumes, networks };
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

function parseCommand(command: unknown, env: Record<string, string>): string | undefined {
  if (typeof command === "string") return interpolateComposeString(command, env);
  if (Array.isArray(command)) {
    return command.map((part) => interpolateComposeString(String(part), env)).join(" ");
  }
  return undefined;
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

  return Object.keys(advanced).length > 0 ? advanced : undefined;
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

  for (const rawLine of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();

    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const parsed = parseEnvValue(line.slice(eqIdx + 1));
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

function interpolateComposeString(input: string, env: Record<string, string>): string {
  const escapedDollar = "\0COMPOSE_ESCAPED_DOLLAR\0";
  const protectedInput = input.replace(/\$\$/g, escapedDollar);

  return protectedInput
    .replace(
      /\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
      (_match, braced: string | undefined, bare: string | undefined) =>
        braced !== undefined
          ? resolveInterpolationExpression(braced, env).value
          : (env[bare!] ?? ""),
    )
    .replaceAll(escapedDollar, "$");
}

function resolveComposeValue(
  input: string,
  env: Record<string, string>,
): { value: string; meta?: ComposeEnvironmentMeta } {
  const trimmed = input.trim();
  const directBraced = trimmed.match(/^\$\{([^}]+)\}$/s);
  if (directBraced) {
    const resolved = resolveInterpolationExpression(directBraced[1]!, env);
    return {
      value: resolved.value,
      meta: {
        source: resolved.source,
        variable: resolved.variable,
        defaultValue: resolved.defaultValue,
        resolvedValue: resolved.value,
        expression: trimmed,
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
): { value: string; source: ComposeEnvironmentMeta["source"]; variable?: string; defaultValue?: string } {
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
      throw new Error(word());
    case "?":
      if (hasValue) return { value, source: "env-file", variable: key };
      throw new Error(word());
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
