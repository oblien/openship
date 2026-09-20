import { Type } from "@sinclair/typebox";
import { MAX_DEPLOY_SERVICE_TARGETS } from "@repo/core";

/**
 * Request-body schemas for the per-project incoming-webhook routes (declared in
 * project.routes.ts). Wired via `spec.body` so they auto-validate and type the
 * MCP tool. Enum values mirror incoming.service (ACTION_TYPES / AUTH_MODES).
 */

const ActionConfig = Type.Object(
  {
    serviceId: Type.Optional(
      Type.String({
        minLength: 1,
        pattern: "\\S",
        description: "deploy: restrict the redeploy to this service.",
      }),
    ),
    serviceIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, pattern: "\\S" }), {
        minItems: 1,
        maxItems: MAX_DEPLOY_SERVICE_TARGETS,
        uniqueItems: true,
        description: "deploy: redeploy these services together once (omit = whole project).",
      }),
    ),
    jobKey: Type.Optional(
      Type.String({ description: "job: the job to run (required when actionType='job')." }),
    ),
  },
  { additionalProperties: true },
);

/** POST /:id/incoming-webhooks */
export const CreateIncomingWebhookBody = Type.Object({
  actionType: Type.Union([Type.Literal("deploy"), Type.Literal("job")], {
    description: "What calling the hook URL does.",
  }),
  authMode: Type.Optional(
    Type.Union([Type.Literal("token"), Type.Literal("hmac"), Type.Literal("none")], {
      description: "Auth for the hook URL (default 'token'; 'none' is rejected for a job hook).",
    }),
  ),
  actionConfig: Type.Optional(ActionConfig),
  name: Type.Optional(Type.String({ description: "Display name (default 'Webhook')." })),
});

/** PATCH /:id/incoming-webhooks/:hookId — all optional (partial update). */
export const UpdateIncomingWebhookBody = Type.Object({
  actionType: Type.Optional(Type.Union([Type.Literal("deploy"), Type.Literal("job")])),
  authMode: Type.Optional(
    Type.Union([Type.Literal("token"), Type.Literal("hmac"), Type.Literal("none")]),
  ),
  actionConfig: Type.Optional(ActionConfig),
  enabled: Type.Optional(Type.Boolean()),
  name: Type.Optional(Type.String()),
});
