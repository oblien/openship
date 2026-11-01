import { ValidationError, isFullCommitSha } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { githubFetch } from "../github/github.auth";
import { getFileContent } from "../github/github.service";
import { authorizeActionRepository } from "./access";
import type { ReusableSourceReader } from "./reusable";

/** Repository APIs provide content; no URL from YAML is fetched directly. */
export function reusableSourceReader(ctx: ExecutionContext): ReusableSourceReader {
  return async (reference, caller) => {
    const local = /^\.\/(\.(?:github|openship)\/workflows\/[^/@]+\.ya?ml)$/.exec(reference);
    const remote =
      /^([\w.-]+)\/([\w.-]+)\/(\.(?:github|openship)\/workflows\/[^/@]+\.ya?ml)@([^\s]+)$/.exec(
        reference,
      );
    if (!local && !remote)
      throw new ValidationError(`Invalid reusable workflow reference: ${reference}`);
    const owner = remote?.[1] ?? caller.owner;
    const repo = remote?.[2] ?? caller.repo;
    if (!owner || !repo)
      throw new ValidationError("Local reusable workflows require a connected repository");
    const path = local?.[1] ?? remote![3]!;
    await authorizeActionRepository(ctx, owner, repo);
    let sha = caller.sha;
    let ref = caller.ref;
    if (remote) {
      ref = remote[4]!;
      const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      if (!isFullCommitSha(ref)) {
        // GitHub reusable references prefer an exact tag over a same-name branch.
        let resolved: string | undefined;
        const kinds = ref.startsWith("refs/heads/")
          ? ["heads"]
          : ref.startsWith("refs/tags/")
            ? ["tags"]
            : ["tags", "heads"];
        for (const kind of kinds) {
          const name = ref.replace(new RegExp(`^refs/${kind}/`), "");
          const refs = await githubFetch<Array<{ ref: string }>>({
            ctx,
            owner,
            repo,
            url: `${base}/git/matching-refs/${kind}/${encodeURIComponent(name)}`,
          });
          resolved = refs.find((item) => item.ref === `refs/${kind}/${name}`)?.ref;
          if (resolved) break;
        }
        if (!resolved) throw new ValidationError(`Reusable workflow ref ${ref} was not found`);
        ref = resolved;
      }
      const commit = await githubFetch<{ sha: string }>({
        ctx,
        owner,
        repo,
        url: `${base}/commits/${encodeURIComponent(ref)}`,
      });
      sha = commit.sha;
    }
    if (!isFullCommitSha(sha))
      throw new ValidationError("Reusable workflow did not resolve to an immutable commit");
    const file = await getFileContent(ctx, owner, repo, path, { branch: sha });
    return { owner, repo, path, sha, ref, source: file.content };
  };
}
