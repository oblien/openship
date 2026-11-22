import { DEFAULT_GIT_PROVIDER, ValidationError, isFullCommitSha } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { requireGitCapability } from "../git/provider";
import { actionRepository, authorizeActionRepository } from "./access";
import type { ReusableSourceReader } from "./reusable";

/** Repository APIs provide content; no URL from YAML is fetched directly. */
export function reusableSourceReader(ctx: ExecutionContext): ReusableSourceReader {
  return async (reference, caller) => {
    const local = /^\.\/(\.(?:github|openship)\/workflows\/[^/@]+\.ya?ml)$/.exec(reference);
    const remote =
      /^([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+)\/(\.(?:github|openship)\/workflows\/[^/@]+\.ya?ml)@([^\s]+)$/.exec(
        reference,
      );
    if (!local && !remote)
      throw new ValidationError(`Invalid reusable workflow reference: ${reference}`);
    const owner = remote?.[1] ?? caller.owner;
    const repo = remote?.[2] ?? caller.repo;
    if (!owner || !repo)
      throw new ValidationError("Local reusable workflows require a connected repository");
    const path = local?.[1] ?? remote![3]!;
    const gitProvider = caller.gitProvider ?? DEFAULT_GIT_PROVIDER;
    await authorizeActionRepository(ctx, owner, repo, gitProvider);
    const repository = actionRepository(ctx, { owner, repo, gitProvider });
    let sha = caller.sha;
    let ref = caller.ref;
    if (remote) {
      ref = remote[4]!;
      ref = await requireGitCapability(repository.workflows, "reusable workflow resolution").resolveRef(ref, "tag");
      sha = await repository.revision(ref);
    }

    if (!isFullCommitSha(sha))
      throw new ValidationError("Reusable workflow did not resolve to an immutable commit");
    const file = await repository.file(path, sha);
    return { gitProvider, owner, repo, path, sha, ref, source: file.content };
  };
}
