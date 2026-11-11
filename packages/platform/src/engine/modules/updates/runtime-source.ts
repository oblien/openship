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
import { assertGitHubRepoAccess } from "../github/github-access";
import { getRawFile } from "../github/github-application.service";
import { getBranch } from "../github/github.service";
import { publishChange } from "../github/repository-changes";
import {
  getRepositoryChangeAccess,
  isRepositoryCredentialFailure,
  repositoryCredentialError,
  REPOSITORY_PR_PERMISSIONS,
} from "../github/repository-change-access";
import { GitHubApiError } from "../github/github.error";
import { authorization } from "../../lib/authorization";
import { inspectRuntimeSource, replaceRuntimeSourceImage } from "./runtime-source-images";

async function readSourceUnchecked(
  ctx: ExecutionContext,
  projectId: string,
  input: RuntimeSourceInput,
  baseSha?: string,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  assertNotControlPlane(project);
  if (
    project.gitProvider !== "github" ||
    !project.gitOwner ||
    !project.gitRepo ||
    !project.gitBranch
  )
    throw new ValidationError(
      "Connect a GitHub repository and deployment branch to propose a source update. Otherwise edit the image in its source.",
    );
  const { gitOwner: owner, gitRepo: repo, gitBranch: branch } = project;
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
  await assertGitHubRepoAccess(ctx, { owner, repo }, "read");
  const head = await getBranch(ctx, owner, repo, branch);
  if (!head) throw new ValidationError("The deployment branch no longer exists.");
  if (baseSha && head.commit.sha !== baseSha)
    throw new AppError(
      "The deployment branch changed. Reload the file and review the new diff.",
      409,
      "RUNTIME_SOURCE_CHANGED",
    );
  const file = await getRawFile(ctx, { owner, repo, branch: head.commit.sha, file: path });
  if (file.size > 64000) throw new ValidationError("Choose a source file smaller than 64 KB.");
  const inspected = inspectRuntimeSource(file.content, input.format, serviceName);
  const canWriteProject = await authorization.checkPermissionOnResource(ctx, {
    resourceType: "project",
    resourceId: projectId,
    action: "write",
  });
  const publishAccess = canWriteProject
    ? await getRepositoryChangeAccess(ctx, owner, repo, [path])
    : ("workspace_access_required" as const);
  return {
    content: file.content,
    serviceName,
    source: {
      owner,
      repo,
      branch,
      baseSha: head.commit.sha,
      path,
      url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${head.commit.sha}/${path.split("/").map(encodeURIComponent).join("/")}`,
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
}

async function readSource(...args: Parameters<typeof readSourceUnchecked>) {
  try {
    return await readSourceUnchecked(...args);
  } catch (error) {
    // A missing source file is not evidence that the connection needs changing.
    if (
      !(error instanceof GitHubApiError && error.status === 404) &&
      isRepositoryCredentialFailure(error)
    )
      throw repositoryCredentialError();
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
  return publishChange(
    ctx,
    {
      owner: preview.owner,
      repo: preview.repo,
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
    { installationPermissions: REPOSITORY_PR_PERMISSIONS },
  );
}
