import { Type, type Static } from "@sinclair/typebox";

export const RuntimeSourceInputSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 1024 }),
    format: Type.Union([Type.Literal("dockerfile"), Type.Literal("compose")]),
    serviceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export const RuntimeSourceEditSchema = Type.Object(
  {
    ...RuntimeSourceInputSchema.properties,
    baseSha: Type.String({ pattern: "^[a-f0-9]{40}$" }),
    referenceId: Type.String({ minLength: 1, maxLength: 1024 }),
    image: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);
export const RuntimeSourceSchema = Type.Object({
  owner: Type.String(),
  repo: Type.String(),
  branch: Type.String(),
  baseSha: Type.String(),
  path: Type.String(),
  url: Type.String(),
  references: Type.Array(
    Type.Object({
      id: Type.String(),
      label: Type.String(),
      image: Type.String(),
      line: Type.Integer(),
    }),
  ),
  guidance: Type.Array(Type.String()),
});
export const RuntimeSourcePreviewSchema = Type.Object({
  ...RuntimeSourceSchema.properties,
  reviewId: Type.String(),
  before: Type.String(),
  after: Type.String(),
});
export const PublishRuntimeSourceSchema = Type.Object(
  {
    ...RuntimeSourceEditSchema.properties,
    reviewId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    requestId: Type.String({ minLength: 16, maxLength: 64, pattern: "^[a-zA-Z0-9-]+$" }),
  },
  { additionalProperties: false },
);
export type RuntimeSourceInput = Static<typeof RuntimeSourceInputSchema>;
export type RuntimeSourceEdit = Static<typeof RuntimeSourceEditSchema>;
export type RuntimeSource = Static<typeof RuntimeSourceSchema>;
export type RuntimeSourcePreview = Static<typeof RuntimeSourcePreviewSchema>;
export type PublishRuntimeSourceInput = Static<typeof PublishRuntimeSourceSchema>;
