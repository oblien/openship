import { createHash } from "node:crypto";
import { AppError, normalizeRepoPath, NotFoundError, ValidationError } from "@repo/core";
import { repos } from "@repo/db";
import type {
  RuntimeSourceInput,
  RuntimeSourceEdit,
  PublishRuntimeSourceInput,
} from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { assertNotControlPlane, assertResourceInOrg } from "../../lib/resource-access";
import { gitRepository, projectGitProvider, projectRepository, requireGitCapability } from "../git/provider";
import { authorization } from "../../lib/authorization";
import { inspectRuntimeSource, replaceRuntimeSourceImage } from "./runtime-source-images";

async function readSource(
  ctx: ExecutionContext,
  projectId: string,
  input: RuntimeSourceInput,
  baseSha?: string,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  assertNotControlPlane(project);
  if (
    !project.gitOwner ||
    !project.gitRepo ||
    !project.gitBranch
  )
    throw new ValidationError(
      "Connect a repository and deployment branch to propose a source update. Otherwise edit the image in its source.",
    );
  const { gitOwner: owner, gitRepo: repo, gitBranch: branch } = project;
  const provider = projectGitProvider(project);
  const repository = projectRepository(ctx, project);
  const changes = requireGitCapability(repository.changes, "source updates");
  try {
  let serviceName: string | undefined;
  if (input.serviceId) {
    const service = await repos.service.findById(input.serviceId);
    if (!service || service.projectId !== projectId)
      throw new NotFoundError("Service", input.serviceId);
    serviceName = service.name;
  }
  const path = normalizeRepoPath(input.path);
  if (
    !path ||
    path !== input.path ||
    path.split("/").some((p) => p.toLowerCase() === ".git" || /[\x00-\x1f\x7f]/.test(p))
  )
    throw new ValidationError("Select a file inside the repository.");
  await repository.assertAccess("read");
  const head = await repository.branch(branch);
  if (!head) throw new ValidationError("The deployment branch no longer exists.");
  if (baseSha && head.sha !== baseSha)
    throw new AppError(
      "The deployment branch changed. Reload the file and review the new diff.",
      409,
      "RUNTIME_SOURCE_CHANGED",
    );
  const file = await repository.readFile(path, head.sha).catch(
    async (error: unknown) => {
      if (
        await provider.errors.isMissingFile(error)
      ) {
        throw new AppError(
          "This file could not be found on the deployment branch. Choose another file.",
          404,
          "RUNTIME_SOURCE_FILE_NOT_FOUND",
        );
      }
      throw error;
    },
  );
  if (!Number.isFinite(file.size)) throw new ValidationError("Select a file, not a directory.");
  if (file.size > 64000) throw new ValidationError("Choose a source file smaller than 64 KB.");
  const inspected = inspectRuntimeSource(file.content, input.format, serviceName);
  const canWriteProject = await authorization.checkPermissionOnResource(ctx, {
    resourceType: "project",
    resourceId: projectId,
    action: "write",
  });
  const publishAccess = canWriteProject
    ? await changes.access([path])
    : ("workspace_access_required" as const);
  return {
    content: file.content,
    serviceName,
    source: {
      provider: provider.id,
      owner,
      repo,
      branch,
      baseSha: head.sha,
      path,
      url: await repository.fileUrl(path, head.sha),
      references: inspected.references.map(({ id, label, image, line }) => ({
        id,
        label,
        image,
        line,
      })),
      guidance: inspected.guidance,
      publishAccess,
    },
  };
  } catch (error) {
    if (await provider.errors.isCredentialFailure(error)) throw await provider.errors.credentialError();
    if (await provider.errors.isTransient(error)) {
      const unavailable = new AppError(
        `${provider.name} is temporarily unavailable. Try reading the source again shortly.`,
        503, "RUNTIME_SOURCE_UNAVAILABLE",
      );
      unavailable.cause = error;
      throw unavailable;
    }
    throw error;
  }
}

export async function getRuntimeSource(
  ctx: ExecutionContext,
  projectId: string,
  input: RuntimeSourceInput,
) {
  return (await readSource(ctx, projectId, input)).source;
}

export async function previewRuntimeSource(
  ctx: ExecutionContext,
  projectId: string,
  input: RuntimeSourceEdit,
) {
  const {
    content: before,
    serviceName,
    source,
  } = await readSource(ctx, projectId, input, input.baseSha);
  const after = replaceRuntimeSourceImage(
    before,
    input.format,
    input.referenceId,
    input.image,
    serviceName,
  );
  const reviewId = createHash("sha256")
    .update(
      JSON.stringify([
        ctx.organizationId,
        projectId,
        input.serviceId ?? null,
        source.provider,
        source.owner,
        source.repo,
        source.branch,
        source.baseSha,
        source.path,
        input.format,
        input.referenceId,
        input.image,
        before,
        after,
      ]),
    )
    .digest("hex");
  return { ...source, before, after, reviewId };
}

export async function publishRuntimeSource(
  ctx: ExecutionContext,
  projectId: string,
  input: PublishRuntimeSourceInput,
) {
  // Re-read the immutable source and regenerate the exact change. The client
  // cannot submit arbitrary file content or reuse a review for another project.
  const preview = await previewRuntimeSource(ctx, projectId, input);
  if (preview.reviewId !== input.reviewId)
    throw new AppError(
      "This source update changed. Review the diff again before creating a PR.",
      409,
      "RUNTIME_SOURCE_CHANGED",
    );
  const changes = requireGitCapability(gitRepository(ctx, {
    provider: preview.provider, namespace: preview.owner, name: preview.repo,
  }).changes, "source updates");
  return changes.publish(
    {
      requestId: input.requestId,
      pullRequest: true,
      patch: {
        baseBranch: preview.branch,
        baseSha: preview.baseSha,
        title: "Update container image reference",
        description: `Changes one image reference in ${preview.path}.\n\nReview image compatibility and CI before merging into ${preview.branch}. After merging, deploy the new commit through the normal deployment flow and recheck the deployed runtime. Creating or merging this PR does not resolve a security advisory.`,
        files: [{ path: preview.path, content: preview.after }],
      },
    },
  );
}
