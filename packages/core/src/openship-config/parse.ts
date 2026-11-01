/**
 * Validate + coerce raw `openship.json` JSON into a typed {@link OpenshipConfig}.
 *
 * Hand-rolled (no schema dep — mirrors the metadata parsers). Two audiences:
 *   - the deploy prepare pipeline overlays `config` leniently (ignores `errors`);
 *   - `openship config validate` fails when `errors` is non-empty.
 * Every field is optional; unknown top-level keys are warnings, not errors.
 */

import {
  STACK_IDS,
  ROLE_KINDS,
  ROLE_HEALTH_KINDS,
  type RoleHealth,
  type StackRole,
} from "../stacks";
import { ALL_PACKAGE_MANAGERS } from "../stacks";
import type { RoutingConfig } from "../metadata/types";
import {
  OPENSHIP_DOMAIN_TYPES,
  OPENSHIP_READINESS_FAILURE_ACTIONS,
  OPENSHIP_PRODUCTION_MODES,
  OPENSHIP_RESOURCE_TIERS,
  OPENSHIP_RESTARTS,
  OPENSHIP_RUNTIMES,
  OPENSHIP_WORKLOADS,
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
import { normalizeRepoPattern } from "../source-access";
import { validateImageReference } from "../project-source";
import { isValidEnvKey, normalizeProjectRootDirectory } from "../utils";
import { isRuntimeVersion, runtimeVersionError } from "../runtime-version";
import { isValidServiceName } from "../service-name";
import { isComposeDuration } from "../duration";
import { resolveTierResources } from "../resources";

const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "framework",
  "packageManager",
  "rootDirectory",
  "autoDeployPaths",
  "composePath",
  "installCommand",
  "buildCommand",
  "startCommand",
  "releaseCommands",
  "outputDirectory",
  "buildImage",
  "runtimeVersion",
  "runtimeImage",
  "productionPaths",
  "volumes",
  "runtime",
  "productionMode",
  "workload",
  "port",
  "roles",
  "optimize",
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

/**
 * Parse the native service build-argument map into the same normalized shape
 * used by Compose imports. `null` deliberately means "inherit this key from
 * the project build environment"; explicit values are strings and win later in
 * the shared Docker build-argument resolver.
 */
function parseBuildArgs(
  ctx: Ctx,
  v: unknown,
  path: string,
): Record<string, string | null> | undefined {
  if (v === undefined) return undefined;
  if (!ctx.isObj(v)) {
    ctx.err(path, "must be an object of string or null build arguments");
    return undefined;
  }

  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!isValidEnvKey(key)) {
      ctx.err(`${path}.${key}`, "has an invalid build argument name");
      continue;
    }
    if (value === null || typeof value === "string") {
      out[key] = value;
    } else {
      ctx.err(`${path}.${key}`, "must be a string or null");
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
    routes.rewrites = v.rewrites
      .map((r, i) => rule(r, `${path}.rewrites[${i}]`))
      .filter(Boolean) as RoutingConfig["rewrites"];
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
                const value = ctx.str(
                  (kv as Record<string, unknown>)?.value,
                  `${p}.headers[${j}].value`,
                );
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

function parseResources(
  ctx: Ctx,
  v: unknown,
  path: string,
  opts?: { allowSwapDisabled?: boolean },
): OpenshipResources | undefined {
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
  if (opts?.allowSwapDisabled) {
    // Docker can only disable swap by pinning MemorySwap to a real Memory cap,
    // so an explicit 0 is a configuration error rather than "inherit".
    const swapDisabled = ctx.bool(v.swapDisabled, `${path}.swapDisabled`);
    if (swapDisabled !== undefined) {
      if (swapDisabled && r.memoryMb === 0) {
        ctx.err(`${path}.swapDisabled`, "requires a positive memoryMb");
      }
      r.swapDisabled = swapDisabled;
    }
  } else if (v.swapDisabled !== undefined) {
    ctx.err(`${path}.swapDisabled`, "is only supported on services[].resources");
  }
  return r;
}

/** Memory implied by a resources block, including its tier when explicit. */
function resourcesMemoryMb(resources: OpenshipResources | undefined): number | undefined {
  if (resources?.memoryMb !== undefined) return resources.memoryMb;
  return resources?.tier ? resolveTierResources(resources.tier).memoryMb : undefined;
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

function parseServices(
  ctx: Ctx,
  v: unknown,
  path: string,
  projectResources?: OpenshipResources,
): OpenshipService[] | undefined {
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
    if (!isValidServiceName(name)) {
      ctx.err(
        p,
        "requires a service name starting with a letter or digit and containing only letters, digits, dots, underscores or hyphens",
      );
      return;
    }
    const resources = parseResources(ctx, item.resources, `${p}.resources`, {
      allowSwapDisabled: true,
    });
    if (resources?.swapDisabled) {
      // The service's own memory wins over the project's when set; otherwise
      // the limit can be inherited. Neither may resolve to "unlimited".
      const memoryMb = resourcesMemoryMb(resources) ?? resourcesMemoryMb(projectResources) ?? 0;
      if (memoryMb <= 0) {
        ctx.err(`${p}.resources.swapDisabled`, "requires a positive memory limit");
      }
    }
    out.push({
      name,
      image: ctx.str(item.image, `${p}.image`),
      build: ctx.str(item.build, `${p}.build`),
      dockerfile: ctx.str(item.dockerfile, `${p}.dockerfile`),
      buildArgs: parseBuildArgs(ctx, item.buildArgs, `${p}.buildArgs`),
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
      resources,
    });
  });
  return out;
}

function parseRoleHealth(ctx: Ctx, v: unknown, path: string): RoleHealth | undefined {
  if (v === undefined) return undefined;
  if (!ctx.isObj(v)) {
    ctx.err(path, "must be an object");
    return undefined;
  }
  if (v.kind === undefined) {
    ctx.err(`${path}.kind`, "is required");
    return undefined;
  }
  const kind = ctx.enumOf(v.kind, `${path}.kind`, ROLE_HEALTH_KINDS);
  if (kind === undefined) return undefined;
  if (kind === "http") {
    ctx.err(
      `${path}.kind`,
      '"http" is not supported for roles: roles run portless, so an HTTP probe has nothing to call; use "process" or "exec"',
    );
    return undefined;
  }
  const command = ctx.str(v.command, `${path}.command`);
  if (kind === "exec" && !command?.trim()) {
    ctx.err(`${path}.command`, "requires a non-empty command for an exec health check");
    return undefined;
  }
  return {
    kind,
    path: ctx.str(v.path, `${path}.path`),
    command,
  };
}

/** Role names land in container names and labels, so they must be DNS labels. */
const ROLE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Matches the existing app-scaling limit (1-100). */
const MAX_ROLE_REPLICAS = 100;

/**
 * Runtime roles beyond the web process (issue #935). Presence of the field at
 * all - including `[]` - overrides the stack's own `defaultRoles` presets;
 * see `resolveStackRoles`. `kind: "web"` is rejected: the web role is always
 * derived from `startCommand`, never declared here.
 */
function parseRoles(ctx: Ctx, v: unknown, path: string): StackRole[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    ctx.err(path, "must be an array of role objects");
    return undefined;
  }
  const out: StackRole[] = [];
  const seen = new Set<string>();
  v.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!ctx.isObj(item)) {
      ctx.err(p, "must be an object");
      return;
    }
    const name = ctx.str(item.name, `${p}.name`);
    if (!name?.trim()) {
      ctx.err(`${p}.name`, "requires a non-empty `name`");
      return;
    }
    if (!ROLE_NAME_RE.test(name)) {
      ctx.err(
        `${p}.name`,
        "must be a DNS label: lowercase letters, digits and dashes, starting and ending with a letter or digit, at most 63 characters",
      );
      return;
    }
    if (seen.has(name)) {
      ctx.err(`${p}.name`, `duplicates role "${name}"; each role needs a unique name`);
      return;
    }
    seen.add(name);
    if (item.kind === undefined) {
      ctx.err(`${p}.kind`, "is required");
      return;
    }
    const kind = ctx.enumOf(item.kind, `${p}.kind`, ROLE_KINDS);
    if (kind === undefined) return;
    if (kind === "web") {
      ctx.err(`${p}.kind`, '"web" is derived from `startCommand`, not declared in `roles`');
      return;
    }
    const command = ctx.str(item.command, `${p}.command`);
    if (!command?.trim()) {
      ctx.err(`${p}.command`, "requires a non-empty `command`");
      return;
    }
    const replicas = parseReplicas(ctx, item.replicas, `${p}.replicas`);
    const declaredSingleton = ctx.bool(item.singleton, `${p}.singleton`);
    // A scheduler is, by definition, one instance.
    const singleton = kind === "scheduler" ? true : declaredSingleton;
    if (singleton && replicas !== undefined && replicas > 1) {
      ctx.err(
        `${p}.replicas`,
        kind === "scheduler"
          ? `conflicts with kind "scheduler", which is always a singleton; remove \`replicas\` or use kind "worker"`
          : "conflicts with `singleton: true`; a singleton runs exactly one instance",
      );
      return;
    }
    const stopSignal = parseStopSignal(ctx, item.stopSignal, `${p}.stopSignal`);
    const stopGracePeriod = parseStopGracePeriod(ctx, item.stopGracePeriod, `${p}.stopGracePeriod`);
    // Preset gating only (see StackRole): a declared role always runs. Say so,
    // or a role copied from a preset silently loses the condition it relied on.
    const gateKeys = (["when", "unless"] as const).filter((key) => item[key] !== undefined);
    if (gateKeys.length > 0) {
      const keys = gateKeys.map((key) => `\`${key}\``).join(" and ");
      const verbs =
        gateKeys.length === 1
          ? "applies only to stack presets and is"
          : "apply only to stack presets and are";
      ctx.warnings.push(`${p} ("${name}"): ${keys} ${verbs} ignored, so this role always runs`);
    }
    if (item.slot !== undefined) {
      ctx.warnings.push(
        `${p} ("${name}"): \`slot\` resolves alternatives only in stack presets; ignored for an explicit role. Declare only the roles you intend to run.`,
      );
    }
    out.push({
      name,
      kind,
      command,
      replicas,
      singleton,
      health: parseRoleHealth(ctx, item.health, `${p}.health`),
      stopSignal,
      stopGracePeriod,
    });
  });
  return out;
}

function parseStopSignal(ctx: Ctx, v: unknown, path: string): string | undefined {
  const sig = ctx.str(v, path);
  if (sig === undefined) return undefined;
  if (!/^SIG[A-Z0-9]+$/.test(sig) && !/^[1-9]\d*$/.test(sig)) {
    ctx.err(path, 'must be a signal name like "SIGTERM" or a positive integer');
    return undefined;
  }
  return sig;
}

// The shared grammar in `../duration`, which the runtime and the compose parser
// read too, so a value accepted here is one the runtime applies as written.

function parseStopGracePeriod(ctx: Ctx, v: unknown, path: string): string | undefined {
  const dur = ctx.str(v, path);
  if (dur === undefined) return undefined;
  if (!isComposeDuration(dur)) {
    ctx.err(path, 'must be a duration like "90s", "1m30s", "10m", or a bare number of seconds');
    return undefined;
  }
  return dur;
}

function parseReplicas(ctx: Ctx, v: unknown, path: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > MAX_ROLE_REPLICAS) {
    ctx.err(path, `must be an integer between 1 and ${MAX_ROLE_REPLICAS}`);
    return undefined;
  }
  return v;
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
      const roots = new Map<string, number>();
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
        const root = normalizeProjectRootDirectory(rootDirectory);
        if (roots.has(root)) {
          ctx.err(
            `${p}.rootDirectory`,
            `duplicates ${path}.apps[${roots.get(root)}]; each override must target a different detected app`,
          );
          return;
        }
        roots.set(root, i);
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

function parseRuntimeImage(ctx: Ctx, raw: unknown): string | undefined {
  const image = ctx.str(raw, "runtimeImage");
  if (image === undefined) return undefined;
  if (!image.trim() || image.length > 200 || validateImageReference(image.trim())) {
    ctx.err("runtimeImage", "must be a valid Docker image reference");
    return undefined;
  }
  return image.trim();
}

function parseRuntimeVersion(ctx: Ctx, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!isRuntimeVersion(raw)) {
    ctx.err("runtimeVersion", "must be a numeric version such as 8.3 or 8.3.1");
    return undefined;
  }
  return raw;
}

function parseAutoDeployPaths(ctx: Ctx, raw: unknown): OpenshipConfig["autoDeployPaths"] {
  if (raw === undefined) return undefined;
  if (!ctx.isObj(raw)) {
    ctx.err("autoDeployPaths", "must be an object");
    return undefined;
  }
  const result: NonNullable<OpenshipConfig["autoDeployPaths"]> = {};
  for (const key of Object.keys(raw))
    if (key !== "include" && key !== "exclude")
      ctx.err(`autoDeployPaths.${key}`, "is not supported");
  for (const key of ["include", "exclude"] as const) {
    const patterns = ctx.strArray(raw[key], `autoDeployPaths.${key}`);
    if (!patterns) continue;
    if (patterns.length > 50) ctx.err(`autoDeployPaths.${key}`, "must have at most 50 patterns");
    result[key] = [];
    for (const pattern of patterns) {
      const normalized = normalizeRepoPattern(pattern);
      if (
        !normalized ||
        pattern.length > 200 ||
        pattern.startsWith("/") ||
        /[?!\[\]{}]/.test(pattern)
      )
        ctx.err(
          `autoDeployPaths.${key}`,
          "use repo-relative paths with * or **, without traversal or other glob operators",
        );
      else result[key]!.push(normalized);
    }
  }
  return result;
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

  const resources = parseResources(ctx, raw.resources, "resources");
  const config: OpenshipConfig = {
    framework: ctx.enumOf(raw.framework, "framework", STACK_IDS),
    packageManager: parsePackageManager(ctx, raw.packageManager, "packageManager"),
    rootDirectory: ctx.str(raw.rootDirectory, "rootDirectory"),
    autoDeployPaths: parseAutoDeployPaths(ctx, raw.autoDeployPaths),
    composePath: ctx.str(raw.composePath, "composePath"),
    installCommand: ctx.str(raw.installCommand, "installCommand"),
    buildCommand: ctx.str(raw.buildCommand, "buildCommand"),
    startCommand: ctx.str(raw.startCommand, "startCommand"),
    releaseCommands: ctx.strArray(raw.releaseCommands, "releaseCommands"),
    outputDirectory: ctx.str(raw.outputDirectory, "outputDirectory"),
    buildImage: ctx.str(raw.buildImage, "buildImage"),
    runtimeVersion: parseRuntimeVersion(ctx, raw.runtimeVersion),
    runtimeImage: parseRuntimeImage(ctx, raw.runtimeImage),
    productionPaths: ctx.strArray(raw.productionPaths, "productionPaths"),
    volumes: ctx.strArray(raw.volumes, "volumes"),
    runtime: ctx.enumOf(raw.runtime, "runtime", OPENSHIP_RUNTIMES),
    productionMode: ctx.enumOf(raw.productionMode, "productionMode", OPENSHIP_PRODUCTION_MODES),
    workload: ctx.enumOf(raw.workload, "workload", OPENSHIP_WORKLOADS),
    port: ctx.int(raw.port, "port", 1, 65535),
    roles: parseRoles(ctx, raw.roles, "roles"),
    optimize: ctx.bool(raw.optimize, "optimize"),
    env: parseEnv(ctx, raw.env, "env"),
    domains: parseDomains(ctx, raw.domains, "domains"),
    routes: parseRoutes(ctx, raw.routes, "routes"),
    resources,
    readiness: parseReadiness(ctx, raw.readiness, "readiness"),
    services: parseServices(ctx, raw.services, "services", resources),
    monorepo: parseMonorepo(ctx, raw.monorepo, "monorepo"),
  };

  if (config.framework && config.runtimeVersion) {
    const error = runtimeVersionError(config.framework, config.runtimeVersion);
    if (error) ctx.err("runtimeVersion", error);
  }

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
