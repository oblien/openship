/**
 * Validate + coerce raw `openship.json` JSON into a typed {@link OpenshipConfig}.
 *
 * Hand-rolled (no schema dep — mirrors the metadata parsers). Two audiences:
 *   - the deploy prepare pipeline overlays `config` leniently (ignores `errors`);
 *   - `openship config validate` fails when `errors` is non-empty.
 * Every field is optional; unknown top-level keys are warnings, not errors.
 */

import { STACK_IDS } from "../stacks";
import { ALL_PACKAGE_MANAGERS } from "../stacks";
import type { RoutingConfig } from "../metadata/types";
import {
  OPENSHIP_DOMAIN_TYPES,
  OPENSHIP_READINESS_FAILURE_ACTIONS,
  OPENSHIP_PRODUCTION_MODES,
  OPENSHIP_RESOURCE_TIERS,
  OPENSHIP_RESTARTS,
  OPENSHIP_RUNTIMES,
  type OpenshipConfig,
  type OpenshipDomain,
  type OpenshipEnv,
  type OpenshipReadiness,
  type OpenshipHealthcheck,
  type OpenshipMonorepo,
  type OpenshipMonorepoApp,
  type OpenshipResources,
  type OpenshipService,
  type ParseResult,
} from "./schema";

const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "framework",
  "packageManager",
  "rootDirectory",
  "composePath",
  "installCommand",
  "buildCommand",
  "startCommand",
  "outputDirectory",
  "buildImage",
  "productionPaths",
  "volumes",
  "runtime",
  "productionMode",
  "port",
  "env",
  "domains",
  "routes",
  "resources",
  "readiness",
  "services",
  "monorepo",
]);

class Ctx {
  errors: string[] = [];
  warnings: string[] = [];
  err(path: string, msg: string): void {
    this.errors.push(`${path}: ${msg}`);
  }
  isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  str(v: unknown, path: string): string | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== "string") {
      this.err(path, "must be a string");
      return undefined;
    }
    return v;
  }
  bool(v: unknown, path: string): boolean | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") {
      this.err(path, "must be a boolean");
      return undefined;
    }
    return v;
  }
  int(v: unknown, path: string, min: number, max: number): number | undefined {
    if (v === undefined) return undefined;
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      this.err(path, "must be a number");
      return undefined;
    }
    if (n < min || n > max) {
      this.err(path, `must be between ${min} and ${max}`);
      return undefined;
    }
    return n;
  }
  strArray(v: unknown, path: string): string[] | undefined {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) {
      this.err(path, "must be an array of strings");
      return undefined;
    }
    const out: string[] = [];
    v.forEach((item, i) => {
      if (typeof item !== "string") this.err(`${path}[${i}]`, "must be a string");
      else out.push(item);
    });
    return out;
  }
  enumOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !allowed.includes(v as T)) {
      this.err(path, `must be one of: ${allowed.join(", ")}`);
      return undefined;
    }
    return v as T;
  }
}

function parseEnv(ctx: Ctx, v: unknown, path: string): OpenshipEnv | undefined {
  if (v === undefined) return undefined;
  if (!ctx.isObj(v)) {
    ctx.err(path, "must be an object of environment variables");
    return undefined;
  }
  const out: OpenshipEnv = {};
  for (const [key, val] of Object.entries(v)) {
    if (typeof val === "string") {
      out[key] = val;
    } else if (ctx.isObj(val)) {
      if (val.value === undefined) ctx.err(`${path}.${key}.value`, "is required");
      const value = ctx.str(val.value, `${path}.${key}.value`);
      const secret = ctx.bool(val.secret, `${path}.${key}.secret`);
      if (value !== undefined) out[key] = { value, ...(secret !== undefined ? { secret } : {}) };
    } else {
      ctx.err(`${path}.${key}`, 'must be a string or { "value", "secret" }');
    }
  }
  return out;
}

function parseDomains(ctx: Ctx, v: unknown, path: string): OpenshipDomain[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    ctx.err(path, "must be an array of hostnames or domain objects");
    return undefined;
  }
  const out: OpenshipDomain[] = [];
  v.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (typeof item === "string") {
      out.push({ domain: item });
    } else if (ctx.isObj(item)) {
      const domain = ctx.str(item.domain, `${p}.domain`);
      if (!domain) {
        ctx.err(p, "requires a `domain`");
        return;
      }
      out.push({
        domain,
        port: ctx.int(item.port, `${p}.port`, 1, 65535),
        targetPath: ctx.str(item.targetPath, `${p}.targetPath`),
        type: ctx.enumOf(item.type, `${p}.type`, OPENSHIP_DOMAIN_TYPES),
      });
    } else {
      ctx.err(p, "must be a hostname string or a domain object");
    }
  });
  return out;
}

function parseRoutes(ctx: Ctx, v: unknown, path: string): RoutingConfig | undefined {
  if (v === undefined) return undefined;
  if (!ctx.isObj(v)) {
    ctx.err(path, "must be an object");
    return undefined;
  }
  const routes: RoutingConfig = {};
  const rule = (item: unknown, p: string): { source: string; destination: string } | null => {
    if (!ctx.isObj(item)) {
      ctx.err(p, "must be an object with `source` and `destination`");
      return null;
    }
    const source = ctx.str(item.source, `${p}.source`);
    const destination = ctx.str(item.destination, `${p}.destination`);
    return source && destination ? { source, destination } : null;
  };
  if (Array.isArray(v.rewrites)) {
    routes.rewrites = v.rewrites.map((r, i) => rule(r, `${path}.rewrites[${i}]`)).filter(Boolean) as RoutingConfig["rewrites"];
  } else if (v.rewrites !== undefined) ctx.err(`${path}.rewrites`, "must be an array");
  if (Array.isArray(v.redirects)) {
    routes.redirects = v.redirects
      .map((r, i) => {
        const base = rule(r, `${path}.redirects[${i}]`);
        if (!base) return null;
        const o = r as Record<string, unknown>;
        return {
          ...base,
          permanent: ctx.bool(o.permanent, `${path}.redirects[${i}].permanent`),
          statusCode: ctx.int(o.statusCode, `${path}.redirects[${i}].statusCode`, 300, 399),
        };
      })
      .filter(Boolean) as RoutingConfig["redirects"];
  } else if (v.redirects !== undefined) ctx.err(`${path}.redirects`, "must be an array");
  if (Array.isArray(v.headers)) {
    routes.headers = v.headers
      .map((h, i) => {
        const p = `${path}.headers[${i}]`;
        if (!ctx.isObj(h)) {
          ctx.err(p, "must be an object");
          return null;
        }
        const source = ctx.str(h.source, `${p}.source`);
        const list = Array.isArray(h.headers)
          ? (h.headers
              .map((kv, j) => {
                const key = ctx.str((kv as Record<string, unknown>)?.key, `${p}.headers[${j}].key`);
                const value = ctx.str((kv as Record<string, unknown>)?.value, `${p}.headers[${j}].value`);
                return key && value !== undefined ? { key, value } : null;
              })
              .filter(Boolean) as { key: string; value: string }[])
          : [];
        return source ? { source, headers: list } : null;
      })
      .filter(Boolean) as RoutingConfig["headers"];
  } else if (v.headers !== undefined) ctx.err(`${path}.headers`, "must be an array");
  const cleanUrls = ctx.bool(v.cleanUrls, `${path}.cleanUrls`);
  const trailingSlash = ctx.bool(v.trailingSlash, `${path}.trailingSlash`);
  if (cleanUrls !== undefined) routes.cleanUrls = cleanUrls;
  if (trailingSlash !== undefined) routes.trailingSlash = trailingSlash;
  return routes;
}

function parseResources(ctx: Ctx, v: unknown, path: string): OpenshipResources | undefined {
  if (v === undefined) return undefined;
  if (!ctx.isObj(v)) {
    ctx.err(path, "must be an object");
    return undefined;
  }
  // `0` = no limit (self-hosted default — the machine is the cap). The upper
  // bounds are sanity rails only: the REAL ceiling is the target machine's
  // probed capacity, enforced server-side. A flat 4-core / 8192 MB max here made
  // a large self-hosted box impossible to describe.
  const r: OpenshipResources = {
    tier: ctx.enumOf(v.tier, `${path}.tier`, OPENSHIP_RESOURCE_TIERS),
    cpuCores: ctx.int(v.cpuCores, `${path}.cpuCores`, 0, 1024),
    memoryMb: ctx.int(v.memoryMb, `${path}.memoryMb`, 0, 4194304),
    diskMb: ctx.int(v.diskMb, `${path}.diskMb`, 0, 204800),
  };
  return r;
}

/**
 * The project-level deploy-time readiness gate. Not to be confused with
 * `parseHealthcheck` below, which is the Docker-native per-service HEALTHCHECK.
 *
 * Every field is optional and every default is off, so `"readiness": {}` is a
 * legal no-op. The second bounds are sanity rails, not policy: a gate that can
 * hold a deploy open for an hour is a mistake worth catching in the config
 * rather than at deploy time.
 */
function parseReadiness(ctx: Ctx, v: unknown, path: string): OpenshipReadiness | undefined {
  if (v === undefined) return undefined;
  if (!ctx.isObj(v)) {
    ctx.err(path, "must be an object");
    return undefined;
  }
  return {
    enabled: ctx.bool(v.enabled, `${path}.enabled`),
    path: ctx.str(v.path, `${path}.path`),
    port: ctx.int(v.port, `${path}.port`, 1, 65535),
    timeoutSeconds: ctx.int(v.timeoutSeconds, `${path}.timeoutSeconds`, 1, 600),
    stabilization: ctx.bool(v.stabilization, `${path}.stabilization`),
    stabilizationSeconds: ctx.int(v.stabilizationSeconds, `${path}.stabilizationSeconds`, 1, 600),
    onFailure: ctx.enumOf(v.onFailure, `${path}.onFailure`, OPENSHIP_READINESS_FAILURE_ACTIONS),
  };
}

function parseHealthcheck(ctx: Ctx, v: unknown, path: string): OpenshipHealthcheck | undefined {
  if (v === undefined) return undefined;
  if (!ctx.isObj(v)) {
    ctx.err(path, "must be an object");
    return undefined;
  }
  const test =
    typeof v.test === "string"
      ? v.test
      : Array.isArray(v.test)
        ? ctx.strArray(v.test, `${path}.test`)
        : v.test !== undefined
          ? (ctx.err(`${path}.test`, "must be a string or array of strings"), undefined)
          : undefined;
  return {
    test,
    interval: ctx.str(v.interval, `${path}.interval`),
    timeout: ctx.str(v.timeout, `${path}.timeout`),
    retries: ctx.int(v.retries, `${path}.retries`, 0, 100),
    startPeriod: ctx.str(v.startPeriod, `${path}.startPeriod`),
    disable: ctx.bool(v.disable, `${path}.disable`),
  };
}

function parseServices(ctx: Ctx, v: unknown, path: string): OpenshipService[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    ctx.err(path, "must be an array of service objects");
    return undefined;
  }
  const out: OpenshipService[] = [];
  v.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!ctx.isObj(item)) {
      ctx.err(p, "must be an object");
      return;
    }
    const name = ctx.str(item.name, `${p}.name`);
    if (!name) {
      ctx.err(p, "requires a `name`");
      return;
    }
    out.push({
      name,
      image: ctx.str(item.image, `${p}.image`),
      build: ctx.str(item.build, `${p}.build`),
      dockerfile: ctx.str(item.dockerfile, `${p}.dockerfile`),
      ports: ctx.strArray(item.ports, `${p}.ports`),
      volumes: ctx.strArray(item.volumes, `${p}.volumes`),
      dependsOn: ctx.strArray(item.dependsOn, `${p}.dependsOn`),
      env: parseEnv(ctx, item.env, `${p}.env`),
      command: ctx.str(item.command, `${p}.command`),
      restart: ctx.enumOf(item.restart, `${p}.restart`, OPENSHIP_RESTARTS),
      exposed: ctx.bool(item.exposed, `${p}.exposed`),
      exposedPort: ctx.str(item.exposedPort, `${p}.exposedPort`),
      domain: ctx.str(item.domain, `${p}.domain`),
      healthcheck: parseHealthcheck(ctx, item.healthcheck, `${p}.healthcheck`),
      readiness: parseReadiness(ctx, item.readiness, `${p}.readiness`),
      resources: parseResources(ctx, item.resources, `${p}.resources`),
    });
  });
  return out;
}

function parseMonorepo(ctx: Ctx, v: unknown, path: string): OpenshipMonorepo | undefined {
  if (v === undefined) return undefined;
  if (!ctx.isObj(v)) {
    ctx.err(path, "must be an object");
    return undefined;
  }
  const mono: OpenshipMonorepo = {};
  if (v.workspace !== undefined) {
    if (!ctx.isObj(v.workspace)) ctx.err(`${path}.workspace`, "must be an object");
    else {
      const pm = ctx.str(v.workspace.packageManager, `${path}.workspace.packageManager`);
      if (pm) {
        mono.workspace = {
          packageManager: pm,
          prepareCommand: ctx.str(v.workspace.prepareCommand, `${path}.workspace.prepareCommand`),
        };
      } else {
        ctx.err(`${path}.workspace`, "requires a `packageManager`");
      }
    }
  }
  if (v.sharedPaths !== undefined) {
    ctx.warnings.push(`${path}.sharedPaths is not applied yet (ignored)`);
  }
  if (v.apps !== undefined) {
    if (!Array.isArray(v.apps)) ctx.err(`${path}.apps`, "must be an array");
    else {
      const apps: OpenshipMonorepoApp[] = [];
      v.apps.forEach((a, i) => {
        const p = `${path}.apps[${i}]`;
        if (!ctx.isObj(a)) {
          ctx.err(p, "must be an object");
          return;
        }
        const name = ctx.str(a.name, `${p}.name`);
        const rootDirectory = ctx.str(a.rootDirectory, `${p}.rootDirectory`);
        if (!name || !rootDirectory) {
          ctx.err(p, "requires `name` and `rootDirectory`");
          return;
        }
        apps.push({
          name,
          rootDirectory,
          framework: ctx.enumOf(a.framework, `${p}.framework`, STACK_IDS),
          packageManager: parsePackageManager(ctx, a.packageManager, `${p}.packageManager`),
          installCommand: ctx.str(a.installCommand, `${p}.installCommand`),
          buildCommand: ctx.str(a.buildCommand, `${p}.buildCommand`),
          startCommand: ctx.str(a.startCommand, `${p}.startCommand`),
          outputDirectory: ctx.str(a.outputDirectory, `${p}.outputDirectory`),
          buildImage: ctx.str(a.buildImage, `${p}.buildImage`),
          port: ctx.int(a.port, `${p}.port`, 1, 65535),
        });
      });
      mono.apps = apps;
    }
  }
  return mono;
}

function parsePackageManager(ctx: Ctx, v: unknown, path: string): string | undefined {
  const s = ctx.str(v, path);
  if (s === undefined) return undefined;
  if (!ALL_PACKAGE_MANAGERS.includes(s)) {
    ctx.err(path, `must be one of: ${ALL_PACKAGE_MANAGERS.join(", ")}`);
    return undefined;
  }
  return s;
}

/** Parse + validate raw `openship.json` JSON (already `JSON.parse`d) into a config. */
export function parseOpenshipConfig(raw: unknown): ParseResult {
  const ctx = new Ctx();
  if (!ctx.isObj(raw)) {
    return { config: null, errors: ["openship.json must be a JSON object"], warnings: [] };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) ctx.warnings.push(`Unknown field "${key}" (ignored)`);
  }

  const config: OpenshipConfig = {
    framework: ctx.enumOf(raw.framework, "framework", STACK_IDS),
    packageManager: parsePackageManager(ctx, raw.packageManager, "packageManager"),
    rootDirectory: ctx.str(raw.rootDirectory, "rootDirectory"),
    composePath: ctx.str(raw.composePath, "composePath"),
    installCommand: ctx.str(raw.installCommand, "installCommand"),
    buildCommand: ctx.str(raw.buildCommand, "buildCommand"),
    startCommand: ctx.str(raw.startCommand, "startCommand"),
    outputDirectory: ctx.str(raw.outputDirectory, "outputDirectory"),
    buildImage: ctx.str(raw.buildImage, "buildImage"),
    productionPaths: ctx.strArray(raw.productionPaths, "productionPaths"),
    volumes: ctx.strArray(raw.volumes, "volumes"),
    runtime: ctx.enumOf(raw.runtime, "runtime", OPENSHIP_RUNTIMES),
    productionMode: ctx.enumOf(raw.productionMode, "productionMode", OPENSHIP_PRODUCTION_MODES),
    port: ctx.int(raw.port, "port", 1, 65535),
    env: parseEnv(ctx, raw.env, "env"),
    domains: parseDomains(ctx, raw.domains, "domains"),
    routes: parseRoutes(ctx, raw.routes, "routes"),
    resources: parseResources(ctx, raw.resources, "resources"),
    readiness: parseReadiness(ctx, raw.readiness, "readiness"),
    services: parseServices(ctx, raw.services, "services"),
    monorepo: parseMonorepo(ctx, raw.monorepo, "monorepo"),
  };

  // Strip undefined so the overlay only carries fields the user actually declared.
  for (const k of Object.keys(config) as (keyof OpenshipConfig)[]) {
    if (config[k] === undefined) delete config[k];
  }

  return { config, errors: ctx.errors, warnings: ctx.warnings };
}

/** Convenience: parse a raw JSON string. Returns a JSON-parse error in `errors`. */
export function parseOpenshipConfigJson(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      config: null,
      errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
    };
  }
  return parseOpenshipConfig(raw);
}
