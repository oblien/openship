/**
 * Immutable, OpenShip-managed Docker Swarm configs and secrets.
 *
 * Swarm does not permit changing a config or secret in place. Source-backed
 * Compose definitions therefore become content-addressed manager objects, and
 * the rendered stack is rewritten to reference that immutable object while
 * retaining the Compose logical name used by each service mount.
 */

import { createHash } from "node:crypto";
import { dirname, normalize, posix } from "node:path";
import type { CommandExecutor, SwarmDiscoverySnapshot } from "@repo/adapters";
import { AppError } from "@repo/core";
import { parseDocument } from "yaml";

type JsonRecord = Record<string, unknown>;

const RESOURCE_STAGE_PREFIX = "/tmp/openship-swarm-resource.";
const MANAGED_LABEL = "com.openship.swarm.managed-resource";
const PROJECT_LABEL = "com.openship.swarm.project-id";
const KIND_LABEL = "com.openship.swarm.resource-kind";
const LOGICAL_NAME_LABEL = "com.openship.swarm.logical-name";
const DIGEST_LABEL = "com.openship.swarm.content-sha256";
export const MANAGED_RESOURCE_CREATED_AT_LABEL = "com.openship.swarm.created-at";

type ManagedResourceExecutor = Pick<CommandExecutor, "exec" | "writeFile" | "rm">;

export type ManagedSwarmResourceKind = "config" | "secret";

export interface ManagedSwarmResource {
  kind: ManagedSwarmResourceKind;
  /** The stable Compose key mounted by services. */
  logicalName: string;
  /** The immutable Swarm object name attached to this rendered revision. */
  resourceName: string;
  /** Content digest only; secret content is never returned or logged. */
  contentDigest: string;
  /** Source material for the one-way manager-side create operation. */
  content: string;
}

export interface ManagedSwarmResourceRefs {
  configs: string[];
  secrets: string[];
  manifest: Array<Pick<ManagedSwarmResource, "kind" | "logicalName" | "resourceName" | "contentDigest">>;
}

/** Result metadata deliberately distinguishes newly-created objects from reused immutable versions. */
export interface EnsuredManagedSwarmResources extends ManagedSwarmResourceRefs {
  createdResources: ManagedSwarmResource[];
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sourceError(message: string, code: string): AppError {
  return new AppError(message, 409, code);
}

function safeNameSegment(value: string, field: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw sourceError(`${field} cannot be converted into a Swarm resource name.`, "SWARM_MANAGED_RESOURCE_NAME_INVALID");
  return normalized;
}

/** Docker Swarm config and secret names are limited to 64 characters. */
export function versionedSwarmResourceName(projectId: string, logicalName: string, contentDigest: string): string {
  const project = safeNameSegment(projectId, "Project ID");
  const logical = safeNameSegment(logicalName, "Compose resource name");
  const hash = contentDigest.replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw sourceError("Managed resource digest is invalid.", "SWARM_MANAGED_RESOURCE_DIGEST_INVALID");
  const suffix = `_${hash.slice(0, 16)}`;
  const base = `openship_${project}_${logical}`;
  if (base.length <= 64 - suffix.length) return base + suffix;
  // Truncation cannot turn two long Compose keys with equal content into the
  // same manager object. The content digest remains the immutable-version ID;
  // this additional marker preserves logical-resource identity within 64 chars.
  const logicalMarker = createHash("sha256").update(logical).digest("hex").slice(0, 8);
  const boundedSuffix = `_${logicalMarker}${suffix}`;
  return base.slice(0, 64 - boundedSuffix.length) + boundedSuffix;
}

function normalizedSourcePath(value: string): string {
  const normalized = normalize(value).replaceAll("\\", "/");
  return normalized.replace(/^\.\//, "");
}

function sourceFileFor(
  files: Array<{ path: string; content: string }>,
  composePath: string,
  resourcePath: string,
): { path: string; content: string } | undefined {
  const direct = normalizedSourcePath(resourcePath);
  const relative = normalizedSourcePath(posix.join(dirname(composePath), resourcePath));
  return files.find((file) => normalizedSourcePath(file.path) === relative)
    ?? files.find((file) => normalizedSourcePath(file.path) === direct);
}

/**
 * Derives manager-created resources only from `file:` definitions. External
 * references remain caller-managed and are validated by compatibility checks.
 */
export function planManagedSwarmResources(input: {
  projectId: string;
  files: Array<{ path: string; content: string }>;
  composePaths: string[];
}): ManagedSwarmResource[] {
  const definitions = new Map<string, { kind: ManagedSwarmResourceKind; logicalName: string; file: string; composePath: string }>();
  for (const composePath of input.composePaths) {
    const compose = input.files.find((file) => file.path === composePath);
    if (!compose) throw sourceError("A Compose source file is unavailable for managed-resource planning.", "SWARM_SOURCE_FILE_UNAVAILABLE");
    const document = parseDocument(compose.content, { prettyErrors: false });
    if (document.errors.length > 0) throw sourceError("Stack source YAML is invalid.", "SWARM_SOURCE_INVALID");
    const source = record(document.toJSON());
    if (!source) throw sourceError("Stack source must be a YAML mapping.", "SWARM_SOURCE_INVALID");
    for (const kind of ["configs", "secrets"] as const) {
      for (const [logicalName, definition] of Object.entries(record(source[kind]) ?? {})) {
        const value = record(definition);
        if (value?.external) continue;
        const file = text(value?.file);
        if (!file) continue;
        definitions.set(`${kind}:${logicalName}`, { kind: kind === "configs" ? "config" : "secret", logicalName, file, composePath });
      }
    }
  }
  return [...definitions.values()]
    .map((definition) => {
      const sourceFile = sourceFileFor(input.files, definition.composePath, definition.file);
      if (!sourceFile) {
        throw sourceError(
          `Managed ${definition.kind} ${definition.logicalName} references a source file that was not staged.`,
          "SWARM_MANAGED_RESOURCE_FILE_MISSING",
        );
      }
      const contentDigest = `sha256:${createHash("sha256").update(sourceFile.content).digest("hex")}`;
      return {
        kind: definition.kind,
        logicalName: definition.logicalName,
        resourceName: versionedSwarmResourceName(input.projectId, definition.logicalName, contentDigest),
        contentDigest,
        content: sourceFile.content,
      } satisfies ManagedSwarmResource;
    })
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.logicalName.localeCompare(right.logicalName));
}

/** Plans encrypted operator-entered input without putting its value in Compose source. */
export function planManagedInputResources(input: {
  projectId: string;
  inputs: Array<{ kind: ManagedSwarmResourceKind; logicalName: string; content: string }>;
}): ManagedSwarmResource[] {
  const seen = new Set<string>();
  return input.inputs.map((entry) => {
    const key = `${entry.kind}:${entry.logicalName}`;
    if (seen.has(key)) throw sourceError(`Managed ${entry.kind} ${entry.logicalName} is duplicated.`, "SWARM_MANAGED_RESOURCE_DUPLICATE");
    seen.add(key);
    const contentDigest = `sha256:${createHash("sha256").update(entry.content).digest("hex")}`;
    return {
      kind: entry.kind,
      logicalName: entry.logicalName,
      resourceName: versionedSwarmResourceName(input.projectId, entry.logicalName, contentDigest),
      contentDigest,
      content: entry.content,
    };
  }).sort((left, right) => left.kind.localeCompare(right.kind) || left.logicalName.localeCompare(right.logicalName));
}

/** Replaces only top-level resource definitions; service mount target/source keys remain untouched. */
export function bindManagedSwarmResources(renderedYaml: string, resources: ManagedSwarmResource[]): string {
  if (resources.length === 0) return renderedYaml;
  const document = parseDocument(renderedYaml, { prettyErrors: false });
  if (document.errors.length > 0 || !record(document.toJSON())) {
    throw sourceError("Rendered stack YAML could not be rewritten for managed resources.", "SWARM_RENDER_INVALID");
  }
  for (const resource of resources) {
    const section = resource.kind === "config" ? "configs" : "secrets";
    // Docker Swarm's stack deploy accepts the canonical Compose form below.
    // The superficially similar nested `external: { name: ... }` form is not
    // treated as external by every Docker stack implementation.
    document.setIn([section, resource.logicalName], { external: true, name: resource.resourceName });
  }
  return document.toString();
}

function labelsFor(resource: ManagedSwarmResource, projectId: string): Record<string, string> {
  return {
    [MANAGED_LABEL]: "true",
    [PROJECT_LABEL]: projectId,
    [KIND_LABEL]: resource.kind,
    [LOGICAL_NAME_LABEL]: resource.logicalName,
    [DIGEST_LABEL]: resource.contentDigest,
  };
}

function metadataMatches(existing: { labels: Record<string, string> }, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => existing.labels[key] === value);
}

function stagePath(stage: string, index: number): string {
  return `${stage}/resource-${index}`;
}

function refs(resources: ManagedSwarmResource[]): ManagedSwarmResourceRefs {
  return {
    configs: resources.filter((resource) => resource.kind === "config").map((resource) => resource.resourceName),
    secrets: resources.filter((resource) => resource.kind === "secret").map((resource) => resource.resourceName),
    manifest: resources.map(({ kind, logicalName, resourceName, contentDigest }) => ({ kind, logicalName, resourceName, contentDigest })),
  };
}

/**
 * Removes only resource versions created by the current pre-apply attempt.
 * Callers must use this before `docker stack deploy`; after an apply starts,
 * the resource may already be referenced by a Swarm service and is retained
 * for the revision/GC lifecycle instead.
 */
export async function removeNewManagedSwarmResources(
  executor: Pick<ManagedResourceExecutor, "exec">,
  resources: ManagedSwarmResource[],
): Promise<void> {
  await Promise.all(resources.map((resource) =>
    executor.exec(`docker ${resource.kind} rm ${shellQuote(resource.resourceName)} >/dev/null 2>&1 || true`).catch(() => undefined),
  ));
}

function referencedName(logicalName: string, definition: unknown): string {
  const value = record(definition);
  const external = value?.external;
  if (external === true) return text(value?.name) ?? logicalName;
  return text(record(external)?.name) ?? text(value?.name) ?? logicalName;
}

/** Actual Swarm object names referenced by a rendered document, never payloads. */
export function referencedSwarmResourceRefs(renderedYaml: string): Pick<ManagedSwarmResourceRefs, "configs" | "secrets"> {
  const document = parseDocument(renderedYaml, { prettyErrors: false });
  if (document.errors.length > 0) throw sourceError("Rendered stack YAML could not be read for resource references.", "SWARM_RENDER_INVALID");
  const source = record(document.toJSON());
  if (!source) throw sourceError("Rendered stack YAML must be a mapping.", "SWARM_RENDER_INVALID");
  const references = (section: "configs" | "secrets") =>
    Object.entries(record(source[section]) ?? {})
      .map(([logicalName, definition]) => referencedName(logicalName, definition))
      .sort();
  return { configs: references("configs"), secrets: references("secrets") };
}

/**
 * Creates missing immutable objects. It treats list-discovery metadata as the
 * only read surface: in particular it never asks Docker to inspect/export a
 * secret payload. On partial creation failure, only objects created by this
 * invocation are removed.
 */
export async function ensureManagedSwarmResources(input: {
  executor: ManagedResourceExecutor;
  discovery: Pick<SwarmDiscoverySnapshot, "configs" | "secrets">;
  projectId: string;
  resources: ManagedSwarmResource[];
}): Promise<EnsuredManagedSwarmResources> {
  if (input.resources.length === 0) return { ...refs([]), createdResources: [] };
  const existing = {
    config: new Map(input.discovery.configs.map((resource) => [resource.name, resource])),
    secret: new Map(input.discovery.secrets.map((resource) => [resource.name, resource])),
  };
  const created: ManagedSwarmResource[] = [];
  let stage: string | null = null;
  try {
    for (const resource of input.resources) {
      const current = existing[resource.kind].get(resource.resourceName);
      const expectedLabels = labelsFor(resource, input.projectId);
      if (current) {
        if (!metadataMatches(current, expectedLabels)) {
          throw sourceError(
            `Swarm ${resource.kind} ${resource.resourceName} already exists but is not the expected OpenShip-managed immutable version.`,
            "SWARM_MANAGED_RESOURCE_CONFLICT",
          );
        }
        continue;
      }
      if (!stage) {
        stage = (await input.executor.exec(`umask 077 && mktemp -d ${RESOURCE_STAGE_PREFIX}XXXXXX`)).trim();
        if (!new RegExp(`^${RESOURCE_STAGE_PREFIX.replace(".", "\\.")}[A-Za-z0-9]+$`).test(stage)) {
          throw sourceError("Manager returned an invalid managed-resource staging directory.", "SWARM_MANAGED_RESOURCE_STAGE_INVALID");
        }
      }
      const payloadPath = stagePath(stage, created.length);
      await input.executor.writeFile(payloadPath, resource.content);
      // Docker's list view reports a human-relative CreatedAt value. Keep the
      // exact creation instant as safe metadata so later GC stays list-only
      // and never needs to inspect a secret object.
      const createLabels = {
        ...expectedLabels,
        [MANAGED_RESOURCE_CREATED_AT_LABEL]: new Date().toISOString(),
      };
      const command = [
        `docker ${resource.kind} create`,
        ...Object.entries(createLabels).map(([key, value]) => `--label ${shellQuote(`${key}=${value}`)}`),
        shellQuote(resource.resourceName),
        shellQuote(payloadPath),
      ].join(" ");
      await input.executor.exec(command);
      created.push(resource);
    }
    return { ...refs(input.resources), createdResources: created };
  } catch (error) {
    await removeNewManagedSwarmResources(input.executor, created);
    throw error;
  } finally {
    if (stage) await input.executor.rm(stage).catch(() => undefined);
  }
}
