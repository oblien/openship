/**
 * GitHub validation schemas — TypeBox schemas for Hono request validation.
 *
 * Uses @sinclair/typebox for JSON-Schema-compatible compile-time + runtime
 * validation, integrated with Hono via @hono/typebox-validator.
 */

import { Type, type Static } from "@sinclair/typebox";

// ─── Route params ────────────────────────────────────────────────────────────

export const OwnerRepoParams = Type.Object({
  owner: Type.String({ minLength: 1, maxLength: 100 }),
  repo: Type.String({ minLength: 1, maxLength: 100 }),
});

export const OrgParams = Type.Object({
  org: Type.String({ minLength: 1, maxLength: 100 }),
});

// ─── Query params ────────────────────────────────────────────────────────────

export const RepoQuery = Type.Object({
  owner: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
});

export const FileQuery = Type.Object({
  branch: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  path: Type.Optional(Type.String({ maxLength: 500 })),
});

// ─── Request bodies ──────────────────────────────────────────────────────────

export const CreateRepoBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-zA-Z0-9._-]+$" }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  private: Type.Optional(Type.Boolean({ default: false })),
  owner: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
});

export const WebhookDeleteBody = Type.Object({
  hookId: Type.Number(),
});

// ─── Type helpers (infer TS types from schemas) ──────────────────────────────

export type TOwnerRepoParams = Static<typeof OwnerRepoParams>;
export type TOrgParams = Static<typeof OrgParams>;
export type TRepoQuery = Static<typeof RepoQuery>;
export type TFileQuery = Static<typeof FileQuery>;
export type TCreateRepoBody = Static<typeof CreateRepoBody>;
export type TWebhookDeleteBody = Static<typeof WebhookDeleteBody>;
