/**
 * Reviewed filesystem boundary for Swarm source material.
 *
 * Every source-side path must pass through this module before it is read or
 * handed to Docker. It rejects lexical traversal and then resolves symlinks so
 * a repository cannot escape its immutable staging root through a nested link.
 */

import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AppError } from "@repo/core";
import { parseSafeSwarmYaml } from "./swarm-yaml";

export const DEFAULT_SWARM_SOURCE_LIMITS = {
  maxFileBytes: 2_000_000,
  maxAggregateBytes: 10_000_000,
  maxYamlBytes: 2_000_000,
  maxServices: 100,
  maxConfigs: 100,
  maxSecrets: 100,
} as const;

export type SwarmSourceLimits = {
  [Key in keyof typeof DEFAULT_SWARM_SOURCE_LIMITS]?: number;
};
export type SourceReferenceKind = "file" | "directory" | "path";

export interface StackSourceReference {
  field: string;
  path: string;
  kind: SourceReferenceKind;
}

export interface ConfinedSourceFile {
  path: string;
  absolutePath: string;
  content: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function limits(input: SwarmSourceLimits = {}) {
  return { ...DEFAULT_SWARM_SOURCE_LIMITS, ...input };
}

function sourceError(message: string, code = "SWARM_SOURCE_PATH_INVALID"): AppError {
  return new AppError(message, 400, code);
}

/** Validate a user/repository supplied relative path without revealing contents. */
export function assertSafeStagedPath(value: string, field: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized ||
    isAbsolute(normalized) ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw sourceError(`${field} references an unsafe source path.`, "SWARM_SOURCE_PATH_INVALID");
  }
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve a staged file/directory, rejecting lexical and symlink escapes. */
export async function resolveConfinedSourcePath(
  stagingRoot: string,
  requestedPath: string,
  field: string,
  kind: SourceReferenceKind = "file",
): Promise<string> {
  const safePath = assertSafeStagedPath(requestedPath, field);
  const root = await realpath(stagingRoot).catch(() => {
    throw sourceError("Swarm source staging root is unavailable.", "SWARM_SOURCE_STAGING_UNAVAILABLE");
  });
  const lexical = resolve(root, safePath);
  if (!isInside(root, lexical)) {
    throw sourceError(`${field} escapes the staged source root.`, "SWARM_SOURCE_PATH_ESCAPE");
  }
  const resolved = await realpath(lexical).catch(() => {
    throw sourceError(`${field} references a source file that does not exist.`, "SWARM_SOURCE_FILE_MISSING");
  });
  if (!isInside(root, resolved)) {
    throw sourceError(`${field} resolves outside the staged source root.`, "SWARM_SOURCE_PATH_ESCAPE");
  }
  const info = await stat(resolved).catch(() => {
    throw sourceError(`${field} cannot be inspected safely.`, "SWARM_SOURCE_FILE_MISSING");
  });
  if ((kind === "file" && !info.isFile()) || (kind === "directory" && !info.isDirectory())) {
    throw sourceError(`${field} must reference a ${kind} inside the staged source root.`, "SWARM_SOURCE_PATH_INVALID");
  }
  return resolved;
}

/** Read ordered Compose source documents under byte limits. */
export async function readConfinedStackSourceFiles(
  stagingRoot: string,
  composePaths: string[],
  inputLimits: SwarmSourceLimits = {},
): Promise<ConfinedSourceFile[]> {
  const configured = limits(inputLimits);
  let aggregateBytes = 0;
  const files: ConfinedSourceFile[] = [];
  for (const composePath of composePaths) {
    const absolutePath = await resolveConfinedSourcePath(stagingRoot, composePath, "composePaths", "file");
    const info = await stat(absolutePath);
    if (info.size > configured.maxFileBytes) {
      throw sourceError(`composePaths exceeds the per-file source limit.`, "SWARM_SOURCE_TOO_LARGE");
    }
    aggregateBytes += info.size;
    if (aggregateBytes > configured.maxAggregateBytes) {
      throw sourceError("Stack source exceeds the aggregate source limit.", "SWARM_SOURCE_TOO_LARGE");
    }
    const content = await readFile(absolutePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > configured.maxYamlBytes) {
      throw sourceError("Stack YAML exceeds the YAML source limit.", "SWARM_SOURCE_TOO_LARGE");
    }
    files.push({ path: assertSafeStagedPath(composePath, "composePaths"), absolutePath, content });
  }
  return files;
}

function sourcePathFromBind(value: unknown): string | null {
  if (typeof value === "string") {
    const source = value.split(":")[0]?.trim() ?? "";
    // Named volumes have no slash/dot and are not source filesystem reads.
    return source.startsWith(".") || source.startsWith("/") || source.includes("/") || source.includes("\\") ? source : null;
  }
  const bind = record(value);
  return bind?.type === "bind" ? text(bind.source) : null;
}

function envFilePaths(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const detailed = record(entry);
    return text(detailed?.path) ? [text(detailed?.path)!] : [];
  });
}

function namedFileReferences(value: unknown, field: string): StackSourceReference[] {
  const mapping = record(value) ?? {};
  return Object.entries(mapping).flatMap(([name, definition]) => {
    const file = text(record(definition)?.file);
    return file ? [{ field: `${field}.${name}.file`, path: file, kind: "file" as const }] : [];
  });
}

/** Enumerate every source-side filesystem reference in Compose documents. */
export function collectStackSourceReferences(files: Array<{ path: string; content: string }>): StackSourceReference[] {
  const references: StackSourceReference[] = files.map((file) => ({ field: "composePaths", path: file.path, kind: "file" }));
  for (const file of files) {
    const source = record(parseSafeSwarmYaml(file.content, "Source file " + file.path));
    if (!source) throw sourceError(`Source file ${file.path} must be a YAML mapping.`, "SWARM_SOURCE_INVALID");
    references.push(...namedFileReferences(source.configs, "configs"));
    references.push(...namedFileReferences(source.secrets, "secrets"));
    for (const [serviceName, rawService] of Object.entries(record(source.services) ?? {})) {
      const service = record(rawService);
      if (!service) continue;
      const build = service.build;
      if (typeof build === "string") {
        references.push({ field: `services.${serviceName}.build`, path: build, kind: "directory" });
      } else {
        const detail = record(build);
        const context = text(detail?.context) ?? (detail ? "." : null);
        if (context) {
          references.push({ field: `services.${serviceName}.build.context`, path: context, kind: "directory" });
          const dockerfile = text(detail?.dockerfile);
          if (dockerfile) {
            references.push({
              field: `services.${serviceName}.build.dockerfile`,
              path: `${context.replace(/\/$/, "")}/${dockerfile}`,
              kind: "file",
            });
          }
        }
      }
      for (const envFile of envFilePaths(service.env_file)) {
        references.push({ field: `services.${serviceName}.env_file`, path: envFile, kind: "file" });
      }
      for (const volume of Array.isArray(service.volumes) ? service.volumes : []) {
        const sourcePath = sourcePathFromBind(volume);
        // Bind mounts can legitimately point at either a file or directory.
        if (sourcePath) references.push({ field: `services.${serviceName}.volumes`, path: sourcePath, kind: "path" });
      }
    }
  }
  return references;
}

/** Resolve all enumerated source references and apply aggregate document limits. */
export async function validateConfinedStackSource(
  stagingRoot: string,
  files: Array<{ path: string; content: string }>,
  inputLimits: SwarmSourceLimits = {},
): Promise<StackSourceReference[]> {
  const configured = limits(inputLimits);
  const references = collectStackSourceReferences(files);
  let serviceCount = 0;
  let configCount = 0;
  let secretCount = 0;
  for (const file of files) {
    const document = record(parseSafeSwarmYaml(file.content, "Source file " + file.path)) ?? {};
    serviceCount += Object.keys(record(document.services) ?? {}).length;
    configCount += Object.keys(record(document.configs) ?? {}).length;
    secretCount += Object.keys(record(document.secrets) ?? {}).length;
  }
  if (serviceCount > configured.maxServices || configCount > configured.maxConfigs || secretCount > configured.maxSecrets) {
    throw sourceError("Stack source exceeds a service, config, or secret count limit.", "SWARM_SOURCE_TOO_LARGE");
  }
  for (const reference of references) {
    await resolveConfinedSourcePath(stagingRoot, reference.path, reference.field, reference.kind);
  }
  return references;
}
