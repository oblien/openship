import { Type, type Static } from "@sinclair/typebox";

/** One reviewed patch, based on an exact commit. Publishing never updates an existing branch. */
export const RepositoryPatch = Type.Object(
  {
    baseBranch: Type.String({ minLength: 1, maxLength: 200 }),
    baseSha: Type.String({ pattern: "^[a-f0-9]{40}$" }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ maxLength: 4000 }),
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 1024 }),
          content: Type.String({ maxLength: 64000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 10 },
    ),
  },
  { additionalProperties: false },
);
export type RepositoryPatch = Static<typeof RepositoryPatch>;
export const PublishRepositoryChangeInput = Type.Object(
  {
    owner: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-zA-Z0-9-]+$" }),
    repo: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-zA-Z0-9_.-]+$" }),
    requestId: Type.String({ minLength: 16, maxLength: 64, pattern: "^[a-zA-Z0-9-]+$" }),
    pullRequest: Type.Boolean(),
    patch: RepositoryPatch,
  },
  { additionalProperties: false },
);
export type PublishRepositoryChangeInput = Static<typeof PublishRepositoryChangeInput>;
export const PublishedRepositoryChange = Type.Object({
  branch: Type.String(),
  commitSha: Type.String(),
  url: Type.String(),
  pullRequestUrl: Type.Union([Type.String(), Type.Null()]),
});
