import { Type } from "@sinclair/typebox";
import { GitProviderId, GitNamespace, GitRepositoryName } from "./git-inputs";
export * from "./git-inputs";
import { GitHubCollectionSchemas } from "./github";
import type { ResourceOperationSchema, ScopedOperations } from "./resource-operations";
import type { GitRepositoryInfo } from "./git-types";

/** Preserve existing repository payloads; provider selection is part of each request.
 * Authentication callbacks and provider-specific App configuration keep their own contracts.
 */
export const GitProviderInput = Type.Object({
  provider: GitProviderId,
});
const target = {
  ...GitProviderInput.properties,
  owner: GitNamespace,
  repo: GitRepositoryName,
};
const common = GitHubCollectionSchemas;
const { optionalInput: _optionalInput, ...listRepos } = common.listRepos;
export const GitCollectionSchemas = {
  listRepos: {
    ...listRepos,
    input: Type.Object({
      ...common.listRepos.input.properties,
      ...GitProviderInput.properties,
      owner: Type.Optional(target.owner),
    }),
  },
  getRepo: {
    ...common.getRepo,
    input: Type.Object({ ...common.getRepo.input.properties, ...target }),
    output: Type.Unsafe<GitRepositoryInfo>(
      Type.Object({
        ...common.getRepo.output.properties,
        id: Type.Union([Type.String(), Type.Number()]),
      }),
    ),
  },
  listBranches: {
    ...common.listBranches,
    input: Type.Object({ ...common.listBranches.input.properties, ...target }),
    output: Type.Object({
      data: Type.Array(
        Type.Object({ name: Type.String(), sha: Type.String(), protected: Type.Boolean() }),
      ),
      pagination: common.listBranches.output.properties.pagination,
    }),
  },
  listFiles: {
    ...common.listFiles,
    input: Type.Object({ ...common.listFiles.input.properties, ...target }),
  },
  listTree: {
    ...common.listTree,
    input: Type.Object({ ...common.listTree.input.properties, ...target }),
  },
  getFile: {
    ...common.getFile,
    input: Type.Object({ ...common.getFile.input.properties, ...target }),
  },
  detectStack: {
    ...common.detectStack,
    input: Type.Object({ ...common.detectStack.input.properties, ...target }),
  },
  publishChange: {
    ...common.publishChange,
    input: Type.Object(
      { ...common.publishChange.input.properties, ...target },
      { additionalProperties: false },
    ),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface GitOperations extends ScopedOperations<typeof GitCollectionSchemas> {}
