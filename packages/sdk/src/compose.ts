import path from "node:path";
import { ValidationError, type TSyncServicesBody } from "@repo/contracts";

/** Input from Docker Compose's normalized JSON, after interpolation. */
export function normalizeComposeServices(
  document: { services?: Record<string, unknown> },
  baseDirectory: string,
): TSyncServicesBody["services"] {
  const errors: string[] = [];
  const services = Object.entries(document.services ?? {}).map(([name, definition]) =>
    mapComposeService(name, definition, baseDirectory, errors),
  );
  if (!services.length) throw new ValidationError("No services found in the compose file");
  if (errors.length)
    throw new ValidationError(
      "This compose file declares options Openship cannot deploy faithfully",
      { services: errors },
    );
  return services as TSyncServicesBody["services"];
}
import {
  commandToArgv,
  composeBuildIssues,
  composeMountIssues,
  composeMountToSpec,
  composePortToSpec,
  parseComposeNamespace,
  type ComposeAdvanced,
} from "@repo/core";
/** Rewrite an absolute build context (as docker resolves it) back to a repo-relative path. */
function relativizeContext(ctx: string | undefined, baseDir: string): string | undefined {
  if (!ctx) return undefined;
  if (!path.isAbsolute(ctx)) return ctx;
  const rel = path.relative(baseDir, ctx);
  if (rel === "") return ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// `docker compose config` ALWAYS normalizes to long form, so these two are the
// only path a synced port or mount takes — which is why they spelling their own
// fold was so costly: this mapper dropped `read_only`, and every `:ro` in every
// synced compose file became a WRITABLE bind mount of a host directory the author
// had marked read-only. It dropped `host_ip` the same way. Both now go through the
// one shared fold in @repo/core, the same one the API's YAML parser uses (#533).
function mapPorts(ports: unknown): string[] {
  if (!Array.isArray(ports)) return [];
  return ports.map((p) => {
    if (typeof p === "string") return p;
    if (typeof p === "number") return String(p);
    if (p && typeof p === "object") {
      const spec = composePortToSpec(p as Record<string, unknown>);
      if (spec !== undefined) return spec;
    }
    return String(p);
  });
}

function mapVolumes(vols: unknown, name: string, errors: string[]): string[] {
  if (!Array.isArray(vols)) return [];
  return vols.map((v) => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      // The same mount rules the API import enforces. Without this, a file the
      // wizard refuses (a tmpfs that would become persistent disk, a subpath that
      // would mount the whole volume) synced cleanly through the CLI instead —
      // one policy accepted by one door and rejected by the other.
      for (const issue of composeMountIssues(v as Record<string, unknown>)) {
        if (issue.blocking) errors.push(`  ${name}: ${issue.reason}`);
      }
      const spec = composeMountToSpec(v as Record<string, unknown>);
      if (spec !== undefined) return spec;
    }
    return String(v);
  });
}

function mapEnv(env: unknown): Record<string, string> {
  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const item of env) {
      if (typeof item !== "string") continue;
      const i = item.indexOf("=");
      if (i > 0) out[item.slice(0, i)] = item.slice(i + 1);
      else out[item] = "";
    }
    return out;
  }
  if (env && typeof env === "object") {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(env as Record<string, unknown>)) {
      out[k] = val == null ? "" : String(val);
    }
    return out;
  }
  return {};
}

function mapDependsOn(deps: unknown): string[] {
  if (Array.isArray(deps)) return deps.filter((d): d is string => typeof d === "string");
  if (deps && typeof deps === "object") return Object.keys(deps);
  return [];
}

function mapBuildArgs(raw: unknown): Record<string, string | null> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const args: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) args[key] = null;
    else if (["string", "number", "boolean"].includes(typeof value)) {
      args[key] = String(value);
    }
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

/**
 * Shared namespaces for the sync payload, refusing what can't be honored.
 *
 * Returns the rejection reasons alongside the value so `sync` can print them and
 * exit non-zero rather than uploading a service list that quietly omits them —
 * the CLI's half of "error out instead of silently dropping" (#533).
 */
function mapNamespaces(
  name: string,
  d: Record<string, unknown>,
): { advanced: ComposeAdvanced; errors: string[] } {
  const advanced: ComposeAdvanced = {};
  const errors: string[] = [];
  for (const [key, raw, field] of [
    ["networkMode", d.network_mode, "network_mode"],
    ["pidMode", d.pid, "pid"],
  ] as const) {
    const parsed = parseComposeNamespace(raw, field);
    if (!parsed) continue;
    if (parsed.ok) advanced[key] = parsed.value;
    else errors.push(`  ${name}: ${parsed.reason}`);
  }
  return { advanced, errors };
}

export function mapComposeService(
  name: string,
  def: unknown,
  baseDir: string,
  errors: string[],
): Record<string, unknown> {
  const d = (def ?? {}) as Record<string, unknown>;
  const svc: Record<string, unknown> = { name };

  if (typeof d.image === "string") svc.image = d.image;

  const build = d.build;
  // `docker compose config` has already normalized local contexts to absolute
  // paths, so those are safe here (and are relativized back below). Everything
  // else follows the same fail-closed build policy as the API YAML importer:
  // syncing must not silently discard a target, secret/SSH contract, malformed
  // arg, or another build option that can change the produced image.
  for (const issue of composeBuildIssues(build, { allowAbsoluteContext: true })) {
    if (issue.blocking) errors.push(`  ${name}: ${issue.reason}`);
  }
  if (typeof build === "string") {
    svc.build = relativizeContext(build, baseDir);
  } else if (build && typeof build === "object") {
    const b = build as Record<string, unknown>;
    svc.build = relativizeContext(typeof b.context === "string" ? b.context : ".", baseDir);
    if (typeof b.dockerfile === "string") svc.dockerfile = b.dockerfile;
    const buildArgs = mapBuildArgs(b.args);
    if (buildArgs) svc.buildArgs = buildArgs;
  }

  const ports = mapPorts(d.ports);
  if (ports.length) svc.ports = ports;
  const dependsOn = mapDependsOn(d.depends_on);
  if (dependsOn.length) svc.dependsOn = dependsOn;
  const environment = mapEnv(d.environment);
  if (Object.keys(environment).length) svc.environment = environment;
  const volumes = mapVolumes(d.volumes, name, errors);
  if (volumes.length) svc.volumes = volumes;

  // #332: carry structured argv (list verbatim / string shell-split) so the
  // deploy runs the real Cmd, not a `sh -c`-wrapped string that breaks
  // entrypoint+CMD images. `command` string kept for display / legacy.
  const command = d.command as string | string[] | undefined;
  if (command != null) {
    svc.commandArgv = commandToArgv(command);
    svc.command = typeof command === "string" ? command : command.map(String).join(" ");
  }

  if (typeof d.restart === "string") svc.restart = d.restart;

  // Extended keys. The sync endpoint has always accepted `advanced` as an open
  // object; this mapper simply never filled it, so a synced stack lost its shared
  // namespaces the same way it lost read-only mounts.
  const { advanced, errors: namespaceErrors } = mapNamespaces(name, d);
  errors.push(...namespaceErrors);
  // `docker compose config` has already expanded args, including turning `$$`
  // into a literal `$`. An explicit empty marker prevents the API from ever
  // treating that normalized literal as a raw template on a later deploy.
  if (
    build &&
    typeof build === "object" &&
    Object.hasOwn(build as Record<string, unknown>, "args")
  ) {
    advanced.buildArgTemplateKeys = [];
  }
  // Same normalized-output rule for runtime env: Compose has already expanded
  // `${VAR}` and collapsed `$$` to a literal `$`. The explicit empty marker is
  // load-bearing — without it the API's raw/manual sync fallback would treat a
  // normalized `$${VAR}` literal as a fresh `${VAR}` expression and expand it a
  // second time.
  if (Object.hasOwn(d, "environment")) advanced.environmentTemplateKeys = [];
  if (Object.keys(advanced).length > 0) svc.advanced = advanced;

  return svc;
}
