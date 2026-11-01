import { Type, type Static } from "@sinclair/typebox";
import { EnvironmentScopeSchema } from "./environment-scope";

export const ServiceEnvironmentInputSchema = Type.Object(
  {
    environment: Type.Optional(EnvironmentScopeSchema),
    inspectRuntime: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ServiceEnvironmentSchema = Type.Object({
  environment: EnvironmentScopeSchema,
  variables: Type.Array(
    Type.Object({
      key: Type.String(),
      value: Type.String(),
      isSecret: Type.Boolean(),
      source: Type.Union([
        Type.Literal("service"),
        Type.Literal("compose"),
        Type.Literal("project"),
        Type.Literal("generated"),
      ]),
      sourceId: Type.Optional(Type.String()),
      missing: Type.Optional(Type.Boolean()),
    }),
  ),
  missingRequired: Type.Array(Type.String()),
  status: Type.Union([
    Type.Literal("unchecked"),
    Type.Literal("synced"),
    Type.Literal("pending"),
    Type.Literal("unavailable"),
    Type.Literal("not-deployed"),
    Type.Literal("unsupported"),
  ]),
  changedKeys: Type.Array(Type.String()),
  recoverableKeys: Type.Array(Type.String()),
  containerId: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
});

/** Partial edits: inherited values are never copied into the override table on save. */
export const MergeServiceEnvVarsBody = Type.Object(
  {
    environment: EnvironmentScopeSchema,
    upserts: Type.Array(
      Type.Object(
        {
          key: Type.String({ minLength: 1, maxLength: 256 }),
          value: Type.String({ maxLength: 10000 }),
          isSecret: Type.Optional(Type.Boolean()),
          // null asserts there was no override when the editor loaded.
          sourceId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    deletes: Type.Array(
      Type.Object(
        {
          key: Type.String({ minLength: 1, maxLength: 256 }),
          sourceId: Type.String({ minLength: 1, maxLength: 128 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    shared: Type.Optional(
      Type.Object({
        keys: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
          minItems: 1, maxItems: 100, uniqueItems: true,
        }),
        revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

export const ReviewServiceEnvVarsBody = Type.Omit(MergeServiceEnvVarsBody, ["shared"]);
export const ServiceEnvironmentReviewSchema = Type.Object({
  revision: Type.String(),
  changes: Type.Array(
    Type.Object({
      key: Type.String(),
      projectKey: Type.String(),
      services: Type.Array(
        Type.Object({
          id: Type.String(),
          name: Type.String(),
          keys: Type.Array(Type.String()),
        }),
      ),
    }),
  ),
});

export type ServiceEnvironmentInput = Static<typeof ServiceEnvironmentInputSchema>;
export type ServiceEnvironment = Static<typeof ServiceEnvironmentSchema>;
export type MergeServiceEnvVarsInput = Static<typeof MergeServiceEnvVarsBody>;
export type ServiceEnvironmentReview = Static<typeof ServiceEnvironmentReviewSchema>;
