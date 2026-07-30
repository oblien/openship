/** Authoritative source linking/editing. No operation in this file calls Docker. */

import { AppError, ConflictError, NotFoundError } from "@repo/core";
import { SwarmRenderError, type RenderStackInput } from "@repo/adapters";
import { repos, type Project, type SwarmStack } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { encryptSecretField } from "../../lib/credential-encryption";
import { decryptSecretField } from "../../lib/credential-encryption";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";
import type { RequestContext } from "../../lib/request-context";
import * as github from "../github/github.service";
import {
  assertSwarmStackName,
  serializeStackSource,
  validateStackSource,
  type StackSourceInput,
} from "./swarm-source.model";
import { projectSwarmStackSource } from "./swarm-stack-projection";
import { previewSwarmStack, redactRenderWarnings } from "./swarm-preview";
import { evaluateSwarmCompatibility } from "./swarm-compatibility";
import {
  DEFAULT_SWARM_SOURCE_LIMITS,
  assertSafeStagedPath,
  collectStackSourceReferences,
} from "./swarm-source-confinement";

export interface ResolvedSwarmStackSource {
  files: RenderStackInput["files"];
  composePaths: string[];
}

type SwarmRenderSourceFile = RenderStackInput["files"][number];
type RepositoryFileReader = typeof github.getFileContent;

function assertEnabled(): void {
  if (!swarmSupportEnabled()) {
    throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
  }
}

async function stackForProject(projectId: string, organizationId: string) {
  assertEnabled();
  const stack = await repos.swarmStack.getForProjectInOrganization(projectId, organizationId);
  if (!stack) throw new NotFoundError("Swarm stack for project", projectId);
  return stack;
}

export async function getStackSource(projectId: string, organizationId: string) {
  const stack = await stackForProject(projectId, organizationId);
  return serializeStackSource(stack);
}

/** Changes metadata only; no image, service, or manager mutation occurs here. */
export async function setStackRegistry(projectId: string, organizationId: string, registryId: string | null) {
  const stack = await stackForProject(projectId, organizationId);
  let withRegistryAuth = false;
  if (registryId) {
    const registry = await repos.containerRegistry.getInOrganization(registryId, organizationId);
    if (!registry) throw new NotFoundError("Container registry", registryId);
    if (!!registry.username !== !!registry.credentialsEnc) {
      throw new AppError(
        "A registry login needs both a username and credential, or neither for a public registry.",
        409,
        "REGISTRY_CREDENTIALS_INCOMPLETE",
      );
    }
    withRegistryAuth = !!registry.username && !!registry.credentialsEnc;
  }
  const updated = await repos.swarmStack.updateInOrganization(stack.id, organizationId, {
    registryId,
    withRegistryAuth,
  });
  if (!updated) throw new NotFoundError("Swarm stack", stack.id);
  return serializeStackSource(updated);
}

/** Metadata-only opt-in. The cluster Edge itself needs a separate explicit action. */
export async function setStackRoutingMode(
  projectId: string,
  organizationId: string,
  routingMode: "external" | "openship-edge",
) {
  const stack = await stackForProject(projectId, organizationId);
  if (routingMode === "openship-edge" && stack.managementMode !== "managed") {
    throw new AppError(
      "Claim this stack before opting services into OpenShip Edge routing.",
      409,
      "SWARM_EDGE_CLAIM_REQUIRED",
    );
  }
  const updated = await repos.swarmStack.updateInOrganization(stack.id, organizationId, { routingMode });
  if (!updated) throw new NotFoundError("Swarm stack", stack.id);
  return serializeStackSource(updated);
}

/** Replaces acknowledgements so removed source/mount findings cannot linger silently. */
export async function setStorageAcknowledgements(
  projectId: string,
  organizationId: string,
  acknowledgements: string[],
) {
  const stack = await stackForProject(projectId, organizationId);
  const normalized = [...new Set(acknowledgements.map((value) => value.trim()).filter(Boolean))].sort();
  const updated = await repos.swarmStack.updateInOrganization(stack.id, organizationId, {
    storageAcknowledgements: normalized,
  });
  if (!updated) throw new NotFoundError("Swarm stack", stack.id);
  return serializeStackSource(updated);
}

export async function setVolumeReplacementAcknowledgements(
  projectId: string,
  organizationId: string,
  acknowledgements: string[],
) {
  const stack = await stackForProject(projectId, organizationId);
  const updated = await repos.swarmStack.updateInOrganization(stack.id, organizationId, {
    volumeReplacementAcknowledgements: [...new Set(acknowledgements.map((value) => value.trim()).filter(Boolean))].sort(),
  });
  if (!updated) throw new NotFoundError("Swarm stack", stack.id);
  return serializeStackSource(updated);
}

function sourceError(message: string, code: string): AppError {
  return new AppError(message, 409, code);
}

function repositoryRootPath(stack: SwarmStack, path: string): string {
  const relative = assertSafeStagedPath(path, "repository source");
  if (!stack.sourcePath) return relative;
  const root = assertSafeStagedPath(stack.sourcePath, "sourcePath").replace(/\/$/, "");
  return relative === root || relative.startsWith(`${root}/`) ? relative : `${root}/${relative}`;
}

/**
 * Materialize a bounded source set as in-memory manager-stage files. GitHub is
 * used only for the linked project's own repository; callers never supply an
 * arbitrary URL/path and no source is persisted or logged at this boundary.
 */
async function repositorySourceFiles(
  stack: SwarmStack,
  project: Project,
  requestContext: RequestContext,
  readRepositoryFile: RepositoryFileReader,
): Promise<ResolvedSwarmStackSource> {
  if (!project.gitOwner || !project.gitRepo) {
    throw sourceError(
      "Link this project to the repository that owns the stack source before rendering it.",
      "SWARM_SOURCE_REPOSITORY_REQUIRED",
    );
  }
  const composePaths = stack.sourcePaths.map((path) => assertSafeStagedPath(path, "composePaths"));
  if (composePaths.length === 0) {
    throw sourceError("This repository stack source has no compose files.", "SWARM_SOURCE_REQUIRED");
  }
  const ref = stack.sourceCommitSha ?? stack.sourceBranch ?? project.gitBranch ?? undefined;
  const files = new Map<string, SwarmRenderSourceFile>();
  let aggregateBytes = 0;
  const readFile = async (relativePath: string) => {
    const path = assertSafeStagedPath(relativePath, "stack source");
    if (files.has(path)) return;
    let file: Awaited<ReturnType<typeof github.getFileContent>>;
    try {
      file = await readRepositoryFile(
        requestContext,
        project.gitOwner!,
        project.gitRepo!,
        repositoryRootPath(stack, path),
        { branch: ref },
      );
    } catch {
      throw sourceError(
        "OpenShip could not read a linked stack source file from the configured repository.",
        "SWARM_SOURCE_FILE_UNAVAILABLE",
      );
    }
    if (file.size > DEFAULT_SWARM_SOURCE_LIMITS.maxFileBytes) {
      throw sourceError("A linked stack source file exceeds the per-file limit.", "SWARM_SOURCE_TOO_LARGE");
    }
    aggregateBytes += file.size;
    if (aggregateBytes > DEFAULT_SWARM_SOURCE_LIMITS.maxAggregateBytes) {
      throw sourceError("Linked stack source files exceed the aggregate limit.", "SWARM_SOURCE_TOO_LARGE");
    }
    files.set(path, { path, content: file.content });
  };

  for (const path of composePaths) await readFile(path);
  // Docker config/secret/env-file references must sit beside the compose files
  // in the private manager stage. Build contexts and bind directories are not
  // copied: source-built services are blocked until the registry workflow is
  // enabled, and host paths are handled by the confinement preflight.
  const references = collectStackSourceReferences([...files.values()]);
  for (const reference of references) {
    if (reference.kind === "file") await readFile(reference.path);
  }
  if (files.size > 250) {
    throw sourceError("Linked stack source contains too many files to render safely.", "SWARM_SOURCE_TOO_LARGE");
  }
  return { files: [...files.values()], composePaths };
}

/** Shared source resolver used by read-only comparison and the later apply. */
export async function resolveStackSourceFiles(
  stack: SwarmStack,
  project: Project,
  requestContext: RequestContext,
  options: { readRepositoryFile?: RepositoryFileReader } = {},
): Promise<ResolvedSwarmStackSource> {
  if (stack.sourceKind === "inline") {
    const yaml = decryptSecretField(stack.sourceYamlEnc);
    if (!yaml) throw sourceError("This stack has no inline source document.", "SWARM_SOURCE_REQUIRED");
    return { files: [{ path: "compose.yaml", content: yaml }], composePaths: ["compose.yaml"] };
  }
  if (stack.sourceKind === "repository") {
    return repositorySourceFiles(stack, project, requestContext, options.readRepositoryFile ?? github.getFileContent);
  }
  throw sourceError("This observed stack needs authoritative source before it can be rendered.", "SWARM_SOURCE_REQUIRED");
}

/**
 * An admin-requested controller handoff. Inline YAML is returned only to this
 * authenticated request, never logged or persisted again. The generated
 * override is already redacted and contains labels/metadata only.
 */
export async function exportStackHandoff(projectId: string, organizationId: string) {
  const stack = await stackForProject(projectId, organizationId);
  const revision = stack.lastAppliedRevisionId
    ? await repos.swarmStack.getRevisionInOrganization(stack.lastAppliedRevisionId, organizationId)
    : undefined;
  const source = serializeStackSource(stack);
  return {
    stackName: stack.stackName,
    managementMode: stack.managementMode,
    source: {
      ...source,
      ...(stack.sourceKind === "inline" && stack.sourceYamlEnc
        ? { inlineYaml: decryptSecretField(stack.sourceYamlEnc) }
        : {}),
    },
    // A generated override contains OpenShip labels but no secret payloads.
    overrideYaml: revision?.overrideYamlRedacted ?? null,
    revision: revision
      ? { id: revision.id, number: revision.revision, renderedDigest: revision.renderedDigest }
      : null,
    notes: [
      "External configs and secrets are references only; provide their payloads in the receiving controller.",
      "OpenShip labels are retained by default. Removing them requires a separate explicit stack apply after handoff.",
    ],
  };
}

/**
 * Validates and returns a review-safe source descriptor. This deliberately
 * does not stage files or invoke Docker; rendering is a later, explicit step.
 */
export async function validateSource(projectId: string, organizationId: string, input: StackSourceInput) {
  const stack = await stackForProject(projectId, organizationId);
  assertSwarmStackName(stack.stackName);
  const source = validateStackSource(input);
  return {
    valid: true,
    stackName: stack.stackName,
    source: {
      kind: source.kind,
      composePaths: source.sourcePaths,
      sourcePath: source.sourcePath,
      branch: source.sourceBranch,
      commitSha: source.sourceCommitSha,
      digest: source.sourceDigest,
      deployable: source.kind !== "adopted",
    },
  };
}

export async function replaceStackSource(projectId: string, organizationId: string, input: StackSourceInput) {
  const stack = await stackForProject(projectId, organizationId);
  assertSwarmStackName(stack.stackName);
  const source = validateStackSource(input);
  const updated = await repos.swarmStack.updateSourceInOrganization(stack.id, organizationId, source.expectedVersion, {
    sourceKind: source.kind,
    sourceStatus: source.kind === "adopted" ? "missing" : "linked-unvalidated",
    sourcePaths: source.sourcePaths,
    sourcePath: source.sourcePath,
    sourceBranch: source.sourceBranch,
    sourceCommitSha: source.sourceCommitSha,
    sourceYamlEnc: encryptSecretField(source.inlineYaml),
    sourceDigest: source.sourceDigest,
  });
  if (!updated) {
    throw new ConflictError("This stack source changed while you were editing it. Refresh and try again.");
  }
  // A pending claim binds a reviewed source + live digest. Replacing source
  // while still observing invalidates that pair; require a fresh confirmation
  // rather than carrying write authority across an edit.
  if (updated.managementMode === "observe" && updated.claimedAt) {
    await repos.swarmStack.updateInOrganization(updated.id, organizationId, {
      claimedAt: null,
      driftStatus: "unknown",
      driftDetails: { summary: "Stack source changed; management claim must be reviewed again." },
    });
  }
  // Inline source is available at this boundary, so immediately refresh only
  // the derived service projection. Repository source is projected after its
  // files are staged; adopted stacks retain their observed service projection.
  if (source.kind === "inline" && source.inlineYaml) {
    await repos.service.syncSwarmProjections(projectId, projectSwarmStackSource([
      { path: "inline.yaml", content: source.inlineYaml },
    ]).services);
  }
  return serializeStackSource(updated);
}

/**
 * Validate an inline document through the target manager's `docker stack
 * config`. This is cluster-read-only and deliberately returns only digest and
 * warnings; S3.5 supplies the redacted rendered-document preview.
 */
export async function renderStackSource(
  projectId: string,
  organizationId: string,
  environment: Record<string, string> = {},
  requestContext?: RequestContext,
) {
  const stack = await stackForProject(projectId, organizationId);
  if (stack.sourceKind === "adopted") {
    throw new AppError("This observed stack needs authoritative source before it can be rendered.", 409, "SWARM_SOURCE_REQUIRED");
  }
  if (!stack.managerServerId) throw new AppError("This stack no longer has a Swarm manager target.", 409, "SWARM_MANAGER_UNAVAILABLE");
  const project = await repos.project.findByIdInOrganization(projectId, organizationId);
  if (!project) throw new NotFoundError("Project", projectId);
  if (!requestContext) throw new AppError("A request context is required to read repository stack source.", 500, "SWARM_SOURCE_CONTEXT_REQUIRED");
  const resolvedSource = await resolveStackSourceFiles(stack, project, requestContext);

  const sourceProjection = projectSwarmStackSource(
    resolvedSource.composePaths.map((path) => resolvedSource.files.find((file) => file.path === path)!).filter(Boolean),
  );
  const ownershipLabels = Object.fromEntries(sourceProjection.services.map((service) => [
    service.sourceServiceName,
    {
      "com.openship.stack-id": stack.id,
      "com.openship.project-id": projectId,
      "com.openship.source-service": service.sourceServiceName,
    },
  ]));
  try {
    const platform = await resolveTargetPlatform("server", "docker", stack.managerServerId, organizationId, "swarm");
    if (!platform.stackRuntime) throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
    const rendered = await platform.stackRuntime.renderStack({
      files: resolvedSource.files,
      composePaths: resolvedSource.composePaths,
      environment,
      ownershipLabels,
    });
    const observed = await platform.stackRuntime.discover();
    const preview = previewSwarmStack({
      renderedYaml: rendered.renderedYaml,
      renderedDigest: rendered.renderedDigest,
      sourceDigest: stack.sourceDigest,
      liveServices: observed.services.filter((service) => service.stackName === stack.stackName),
      lastObservedLiveDigest: stack.lastObservedDigest,
      interpolationValues: environment,
    });
    const compatibility = evaluateSwarmCompatibility({
      renderedYaml: rendered.renderedYaml,
      discovery: observed,
      registryConfigured: !!stack.registryId,
      acknowledgedStorage: stack.storageAcknowledgements,
    });
    await repos.swarmStack.updateInOrganization(stack.id, organizationId, { sourceStatus: "valid" });
    return {
      valid: true,
      ...preview,
      warnings: redactRenderWarnings(rendered.warnings, environment),
      compatibility,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof SwarmRenderError) {
      // A manager-side config/interpolation failure invalidates the linked
      // source, but a transport error below does not — retrying connectivity
      // should not make otherwise-valid source look syntactically invalid.
      await repos.swarmStack.updateInOrganization(stack.id, organizationId, { sourceStatus: "invalid" });
      throw new AppError(error.message, 400, error.issues[0]?.code ?? "SWARM_STACK_CONFIG_FAILED");
    }
    throw new AppError("Unable to render this stack on its Swarm manager.", 503, "SWARM_MANAGER_UNAVAILABLE");
  }
}
