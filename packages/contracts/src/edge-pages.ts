import { Type, type Static } from "@sinclair/typebox";
import { EDGE_PAGE_STATUSES, EDGE_PAGE_LIMIT, EDGE_RESPONSE_MAX_BYTES } from "@repo/core";

export const EdgePagesSchema = Type.Object(
  {
    files: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
          name: Type.String({ minLength: 1, maxLength: 100 }),
          html: Type.String({ minLength: 1, maxLength: EDGE_RESPONSE_MAX_BYTES }),
        },
        { additionalProperties: false },
      ),
      { maxItems: EDGE_PAGE_LIMIT },
    ),
    errors: Type.Array(
      Type.Object(
        {
          status: Type.Union(EDGE_PAGE_STATUSES.map((status) => Type.Literal(status))),
          pageId: Type.String(),
        },
        { additionalProperties: false },
      ),
      { maxItems: EDGE_PAGE_STATUSES.length },
    ),
    maintenance: Type.Optional(
      Type.Object(
        {
          enabled: Type.Boolean(),
          pageId: Type.Optional(Type.String()),
          retryAfter: Type.Integer({ minimum: 60, maximum: 86400 }),
        },
        { additionalProperties: false },
      ),
    ),
    defaultPageId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ProjectEdgePagesSchema = Type.Object(
  {
    defaults: Type.Optional(EdgePagesSchema),
    hosts: Type.Optional(Type.Record(Type.String(), EdgePagesSchema, { maxProperties: 50 })),
  },
  { additionalProperties: false },
);

export const RouteProtectionOptionsSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("page"), Type.Literal("basic")]),
    username: Type.Optional(
      Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" }),
    ),
    /** Include {{form}} once; the edge inserts its CSRF-protected sign-in form. */
    loginHtml: Type.Optional(Type.String({ maxLength: EDGE_RESPONSE_MAX_BYTES })),
    sessionSeconds: Type.Integer({ minimum: 300, maximum: 604800 }),
  },
  { additionalProperties: false },
);
export type RouteProtectionOptions = Static<typeof RouteProtectionOptionsSchema>;

export const ProjectEdgePagesStatusSchema = Type.Object({
  config: ProjectEdgePagesSchema,
  revision: Type.String(),
  status: Type.Union([
    Type.Literal("applied"),
    Type.Literal("pending"),
    Type.Literal("unpublished"),
  ]),
  message: Type.Optional(Type.String()),
});
export const UpdateProjectEdgePagesSchema = Type.Object(
  {
    config: ProjectEdgePagesSchema,
    expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

export type ProjectEdgePagesStatus = Static<typeof ProjectEdgePagesStatusSchema>;
