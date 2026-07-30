import { Type } from "@sinclair/typebox";

/**
 * Request-body schemas for the project service-connection routes. Wired via
 * `spec.body` (auto-validate + type the MCP tool). `mode` mirrors the service's
 * ConnectionMode ("internal" | "public").
 */

const ConnectionMode = Type.Union([Type.Literal("internal"), Type.Literal("public")], {
  description: "internal = wire over the private network; public = host:port endpoint.",
});

/** POST /:id/connections — wire one source-app output into this project. */
export const CreateConnectionBody = Type.Object({
  sourceProjectId: Type.String({ minLength: 1, description: "Source app/project to draw the output from." }),
  outputId: Type.String({ minLength: 1, description: "Resolved connection-output id on the source app." }),
  envKey: Type.String({ minLength: 1, description: "Target env var name to inject into this project." }),
  mode: Type.Optional(ConnectionMode),
});

/** POST /:id/connections/bundle — wire several outputs atomically (all-or-nothing). */
export const CreateBundleBody = Type.Object({
  sourceProjectId: Type.String({ minLength: 1, description: "Source app/project to draw outputs from." }),
  items: Type.Array(
    Type.Object({
      outputId: Type.String({ minLength: 1 }),
      envKey: Type.String({ minLength: 1 }),
    }),
    { minItems: 1, description: "Outputs to wire, each → an env var." },
  ),
  mode: Type.Optional(ConnectionMode),
});
