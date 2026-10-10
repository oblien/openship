import { Type } from "@sinclair/typebox";

/** One shape for project creation, Source settings and deployment wizard saves. */
export const GitHubDeploymentChecksSchema = Type.Object({
  enabled: Type.Boolean(),
  deployment: Type.Boolean(),
  services: Type.Union([
    Type.Literal("all"),
    Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 200, uniqueItems: true }),
  ]),
  includeErrors: Type.Boolean(),
}, { additionalProperties: false });
