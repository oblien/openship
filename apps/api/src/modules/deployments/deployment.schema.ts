/**
 * Deployment validation schemas — TypeBox for Hono route validation.
 */

import { Type, type Static } from "@sinclair/typebox";

// ─── Route params ────────────────────────────────────────────────────────────

export const DeploymentIdParam = Type.Object({
  id: Type.String({ minLength: 1 }),
});

// ─── Query params ────────────────────────────────────────────────────────────

export const ListDeploymentsQuery = Type.Object({
  projectId: Type.Optional(Type.String()),
  environment: Type.Optional(Type.Union([
    Type.Literal("production"), Type.Literal("preview"),
  ])),
  page: Type.Optional(Type.Number({ minimum: 1, default: 1 })),
  perPage: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
});

// ─── Request bodies ──────────────────────────────────────────────────────────

export const TriggerDeployBody = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  branch: Type.Optional(Type.String({ default: "main" })),
  commitSha: Type.Optional(Type.String()),
  environment: Type.Optional(Type.Union([
    Type.Literal("production"), Type.Literal("preview"),
  ])),
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TDeploymentIdParam = Static<typeof DeploymentIdParam>;
export type TListDeploymentsQuery = Static<typeof ListDeploymentsQuery>;
export type TTriggerDeployBody = Static<typeof TriggerDeployBody>;
