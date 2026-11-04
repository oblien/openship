import { ValidationError, isFullCommitSha } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { githubFetch } from "../github/github.auth";
import { record } from "./workflow";

interface RepositoryIdentity {
  id: number;
  full_name: string;
}
interface PullRequestSide {
  sha: string;
  ref: string;
  repo: RepositoryIdentity;
}
export interface ActionPullRequest {
  number: number;
  repository: RepositoryIdentity;
  base: PullRequestSide;
  head: PullRequestSide;
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha: string | null;
}

function repositoryIdentity(value: unknown): RepositoryIdentity | null {
  const repo = record(value);
  return Number.isSafeInteger(repo.id) &&
    Number(repo.id) > 0 &&
    typeof repo.full_name === "string" &&
    /^[\w.-]+\/[\w.-]+$/.test(repo.full_name)
    ? { id: Number(repo.id), full_name: repo.full_name.toLowerCase() }
    : null;
}
function pullRequestSide(value: unknown): PullRequestSide | null {
  const side = record(value),
    repo = repositoryIdentity(side.repo);
  return repo &&
    typeof side.sha === "string" &&
    isFullCommitSha(side.sha) &&
    typeof side.ref === "string" &&
    side.ref.length > 0
    ? { sha: side.sha.toLowerCase(), ref: side.ref, repo }
    : null;
}

/** Read only captured GitHub identities, never a ref or SHA supplied by workflow code. */
export function actionPullRequest(
  event: Record<string, unknown>,
  owner: string,
  repo: string,
): ActionPullRequest {
  const pr = record(event.pull_request);
  const repository = repositoryIdentity(event.repository);
  const base = pullRequestSide(pr.base),
    head = pullRequestSide(pr.head);
  if (
    !Number.isSafeInteger(event.number) ||
    Number(event.number) <= 0 ||
    pr.number !== event.number ||
    !repository ||
    !base ||
    !head ||
    repository.full_name !== `${owner}/${repo}`.toLowerCase() ||
    base.repo.id !== repository.id ||
    base.repo.full_name !== repository.full_name ||
    (head.repo.id === repository.id) !== (head.repo.full_name === repository.full_name) ||
    (pr.state !== "open" && pr.state !== "closed") ||
    typeof pr.merged !== "boolean"
  )
    throw new ValidationError(
      "The pull request event does not identify a complete repository, base and head.",
    );
  return {
    number: Number(event.number),
    repository,
    base,
    head,
    state: pr.state,
    merged: pr.merged,
    mergeCommitSha:
      typeof pr.merge_commit_sha === "string" && isFullCommitSha(pr.merge_commit_sha)
        ? pr.merge_commit_sha.toLowerCase()
        : null,
  };
}

/** Both webhook admission and first Check publication bind the same ordered parents. */
export async function pullRequestMergeMatches(
  ctx: ExecutionContext,
  owner: string,
  repo: string,
  pr: ActionPullRequest,
  revision: string,
): Promise<boolean> {
  if (!isFullCommitSha(revision)) return false;
  const commit = await githubFetch<{ sha: string; parents: Array<{ sha: string }> }>({
    ctx,
    owner,
    repo,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(revision)}`,
  });
  return (
    commit.sha === revision &&
    commit.parents?.length === 2 &&
    commit.parents[0]?.sha === pr.base.sha &&
    commit.parents[1]?.sha === pr.head.sha
  );
}

/** Closed deliveries run their immutable event commit, without waiting for an open-PR merge. */
export function closedPullRequestRevision(pr: ActionPullRequest) {
  if (pr.state !== "closed" || (pr.merged && !pr.mergeCommitSha))
    throw new ValidationError("The closed pull request has no immutable execution revision.");
  return pr.merged
    ? { ref: `refs/heads/${pr.base.ref}`, revision: pr.mergeCommitSha! }
    : { ref: `refs/pull/${pr.number}/head`, revision: pr.head.sha };
}

/** GitHub computes merges asynchronously. Pending metadata retries through the durable inbox. */
export async function resolvePullRequestRevision(
  ctx: ExecutionContext,
  owner: string,
  repo: string,
  pr: ActionPullRequest,
  action: unknown,
) {
  if (action === "closed") return closedPullRequestRevision(pr);
  if (pr.state !== "open" || pr.merged)
    throw new ValidationError("The pull request event is not an open-PR delivery.");
  const current = await githubFetch<Record<string, unknown>>({
    ctx,
    owner,
    repo,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr.number}`,
  });
  const observed = actionPullRequest(
    {
      number: pr.number,
      repository: pr.repository,
      pull_request: current,
    },
    owner,
    repo,
  );
  if (
    observed.state !== "open" ||
    observed.merged ||
    JSON.stringify(observed.base) !== JSON.stringify(pr.base) ||
    JSON.stringify(observed.head) !== JSON.stringify(pr.head)
  )
    throw new ValidationError("The pull request changed since this delivery; no run was started.");
  if (current.mergeable === false)
    throw new ValidationError("The pull request has merge conflicts; no run was started.");
  const revision = observed.mergeCommitSha;
  if (
    current.mergeable !== true ||
    !revision ||
    !(await pullRequestMergeMatches(ctx, owner, repo, pr, revision))
  )
    throw new Error(
      "The pull request test merge is not ready for this base and head; delivery will retry.",
    );
  return { ref: `refs/pull/${pr.number}/merge`, revision };
}
