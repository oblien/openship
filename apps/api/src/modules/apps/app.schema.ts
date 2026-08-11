import { Type } from "@sinclair/typebox";

/**
 * Request-body schemas for the apps routes. Wired via `spec.body` (auto-validate
 * + type the MCP tool). The custom-app upload is intentionally an OPEN object —
 * the authoritative validation is `parseAppTemplate` (@repo/core) in the service;
 * we only gate "must be a JSON object" here and document the shape for agents.
 */

/** POST /apps — install a catalog app as a project. */
export const InstallAppBody = Type.Object({
  templateId: Type.String({ minLength: 1, description: "Catalog app/template id to install." }),
  name: Type.Optional(Type.String({ description: "Project name (defaults from the template)." })),
  config: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Template config-field values (key → string); keys come from the template's configFields.",
    }),
  ),
  // The install write carries the routing decision. A service with no entry here
  // gets NO public route: a hostname is never invented on the caller's behalf.
  routes: Type.Optional(
    Type.Array(
      Type.Object(
        {
          service: Type.String({ minLength: 1, maxLength: 120, description: "Template service name." }),
          port: Type.Integer({ minimum: 1, maximum: 65535, description: "Container port this choice routes." }),
          mode: Type.Union(
            [Type.Literal("port"), Type.Literal("free"), Type.Literal("custom")],
            {
              description:
                "port = no public route (published host port only); free = managed *.opsh.io subdomain (needs Openship Cloud); custom = your own hostname.",
            },
          ),
          domain: Type.Optional(
            Type.String({
              maxLength: 255,
              description: "free mode: subdomain slug. Omit to take the template's default label.",
            }),
          ),
          customDomain: Type.Optional(
            Type.String({ maxLength: 255, description: "custom mode: the hostname you own (required)." }),
          ),
        },
        { additionalProperties: false },
      ),
      {
        maxItems: 40,
        description: "Per-endpoint routing choice, one entry per exposable endpoint the operator decided on.",
      },
    ),
  ),
});

/** POST /apps/custom — add a custom app from an uploaded JSON app definition. */
export const AddCustomAppBody = Type.Object(
  {},
  {
    additionalProperties: true,
    description:
      "A full AppTemplate JSON definition: { id, name, description, kind:'template', logo, category, ...optional services/configFields/endpoints/settings/... }. Validated strictly server-side; 'flow' apps are rejected.",
  },
);

/** PATCH /projects/:id/app-settings — update an installed app's curated settings. */
export const AppSettingsPatchBody = Type.Object({
  changes: Type.Optional(
    Type.Array(
      Type.Object({
        service: Type.String({ description: "Docker service / alias name." }),
        key: Type.String({ description: "Curated setting env key." }),
        value: Type.String({
          description: "New value ('' clears a non-secret override; '' leaves a secret unchanged).",
        }),
      }),
      { description: "Curated setting changes to apply (safe env merge)." },
    ),
  ),
});
