/**
 * GitHub validation schemas - TypeBox schemas for Hono request validation.
 *
 * Uses @sinclair/typebox for JSON-Schema-compatible compile-time + runtime
 * validation, integrated with Hono via @hono/typebox-validator.
 */

import { Type, type Static } from "@sinclair/typebox";

// ─── Route params ────────────────────────────────────────────────────────────

export const OwnerRepoParams = Type.Object({
  owner: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-zA-Z0-9_-]+$" }),
  repo: Type.String({ minLength: 1, maxLength: 100, pattern: "^(?!\\.{1,2}$)[a-zA-Z0-9._-]+$" }),
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

// ─── Self-hosted GitHub App sources ────────────────────────────────────────

const SourceName = Type.String({ minLength: 1, maxLength: 100 });
const AppId = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
const OptionalEndpoint = Type.Optional(Type.String({ minLength: 8, maxLength: 2048 }));

export const GitHubSourceManifestBody = Type.Object(
  { name: SourceName },
  { additionalProperties: false },
);

export const GitHubSourceManifestConvertBody = Type.Object(
  {
    state: Type.String({ minLength: 16, maxLength: 256 }),
    code: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

export const GitHubSourceManualBody = Type.Object(
  {
    name: SourceName,
    appId: AppId,
    clientId: Type.Optional(Type.String({ maxLength: 255 })),
    clientSecret: Type.Optional(Type.String({ maxLength: 2048 })),
    privateKeyPem: Type.String({ minLength: 1, maxLength: 65_536 }),
    webhookSecret: Type.String({ minLength: 16, maxLength: 2048 }),
    apiBaseUrl: OptionalEndpoint,
    webBaseUrl: OptionalEndpoint,
    isDefault: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const GitHubSourceUpdateBody = Type.Object(
  {
    name: Type.Optional(SourceName),
    appId: Type.Optional(AppId),
    clientId: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    clientSecret: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    privateKeyPem: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
    webhookSecret: Type.Optional(Type.String({ minLength: 16, maxLength: 2048 })),
    apiBaseUrl: OptionalEndpoint,
    webBaseUrl: OptionalEndpoint,
  },
  { additionalProperties: false, minProperties: 1 },
);

// ─── Type helpers (infer TS types from schemas) ──────────────────────────────

export type TOwnerRepoParams = Static<typeof OwnerRepoParams>;
export type TOrgParams = Static<typeof OrgParams>;
export type TRepoQuery = Static<typeof RepoQuery>;
export type TFileQuery = Static<typeof FileQuery>;
export type TCreateRepoBody = Static<typeof CreateRepoBody>;
export type TWebhookDeleteBody = Static<typeof WebhookDeleteBody>;
export type TGitHubSourceManifestBody = Static<typeof GitHubSourceManifestBody>;
export type TGitHubSourceManifestConvertBody = Static<typeof GitHubSourceManifestConvertBody>;
export type TGitHubSourceManualBody = Static<typeof GitHubSourceManualBody>;
export type TGitHubSourceUpdateBody = Static<typeof GitHubSourceUpdateBody>;
