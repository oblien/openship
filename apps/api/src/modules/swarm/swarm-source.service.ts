/** Authoritative source linking/editing. No operation in this file calls Docker. */

import { AppError, ConflictError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { encryptSecretField } from "../../lib/credential-encryption";
import {
  assertSwarmStackName,
  serializeStackSource,
  validateStackSource,
  type StackSourceInput,
} from "./swarm-source.model";
import { projectSwarmStackSource } from "./swarm-stack-projection";

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
