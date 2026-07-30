/** Authoritative source linking/editing. No operation in this file calls Docker. */

import { AppError, ConflictError, NotFoundError } from "@repo/core";
import { SwarmRenderError } from "@repo/adapters";
import { repos } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { encryptSecretField } from "../../lib/credential-encryption";
import { decryptSecretField } from "../../lib/credential-encryption";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";
import {
  assertSwarmStackName,
  serializeStackSource,
  validateStackSource,
  type StackSourceInput,
} from "./swarm-source.model";
import { projectSwarmStackSource } from "./swarm-stack-projection";
import { previewSwarmStack, redactRenderWarnings } from "./swarm-preview";
import { evaluateSwarmCompatibility } from "./swarm-compatibility";

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
  return serializeStackSource(await stackForProject(projectId, organizationId));
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
) {
  const stack = await stackForProject(projectId, organizationId);
  if (stack.sourceKind === "adopted") {
    throw new AppError("This observed stack needs authoritative source before it can be rendered.", 409, "SWARM_SOURCE_REQUIRED");
  }
  if (stack.sourceKind !== "inline") {
    throw new AppError("Repository stack source must be staged from its linked repository before rendering.", 409, "SWARM_SOURCE_STAGING_REQUIRED");
  }
  const yaml = decryptSecretField(stack.sourceYamlEnc);
  if (!yaml) throw new AppError("This stack has no inline source document.", 409, "SWARM_SOURCE_REQUIRED");
  if (!stack.managerServerId) throw new AppError("This stack no longer has a Swarm manager target.", 409, "SWARM_MANAGER_UNAVAILABLE");

  const sourceProjection = projectSwarmStackSource([{ path: "compose.yaml", content: yaml }]);
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
      files: [{ path: "compose.yaml", content: yaml }],
      composePaths: ["compose.yaml"],
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
    });
    return {
      valid: true,
      ...preview,
      warnings: redactRenderWarnings(rendered.warnings, environment),
      compatibility,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof SwarmRenderError) {
      throw new AppError(error.message, 400, error.issues[0]?.code ?? "SWARM_STACK_CONFIG_FAILED");
    }
    throw new AppError("Unable to render this stack on its Swarm manager.", 503, "SWARM_MANAGER_UNAVAILABLE");
  }
}
