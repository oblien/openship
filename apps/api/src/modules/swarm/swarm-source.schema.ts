import { Type, type Static } from "@sinclair/typebox";

const SourceVersion = Type.Integer({ minimum: 1 });

export const UpdateSwarmStackSourceBody = Type.Union([
  Type.Object({
    kind: Type.Literal("inline"),
    yaml: Type.String({ minLength: 1, maxLength: 1_000_000 }),
    expectedVersion: SourceVersion,
  }),
  Type.Object({
    kind: Type.Literal("repository"),
    composePaths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 20 }),
    sourcePath: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    branch: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    commitSha: Type.Optional(Type.String({ minLength: 7, maxLength: 64 })),
    expectedVersion: SourceVersion,
  }),
  Type.Object({
    kind: Type.Literal("adopted"),
    expectedVersion: SourceVersion,
  }),
]);

export type TUpdateSwarmStackSourceBody = Static<typeof UpdateSwarmStackSourceBody>;
