import { z } from "zod";

/**
 * Runtime shape gate for a repo-fetched app-catalog overlay. The BUNDLED catalog
 * is generated + trusted and imported directly (no reparse — casting avoids
 * stripping fields). This validates a REMOTE catalog entry's shape before it's
 * allowed to drive installs. Behavior-driving fields (services/images/volumes/
 * commands, config, files) are validated strictly; UI-only metadata (settings,
 * management) is kept loose. Extra keys are ignored (zod strips on parse but
 * safeParse still succeeds), so forward-added fields never falsely reject.
 */

const serviceSpec = z.object({
  name: z.string(),
  image: z.string(),
  ports: z.array(z.string()).optional(),
  exposedPort: z.number().optional(),
  routes: z
    .array(z.object({ port: z.number(), slugSuffix: z.string().optional() }))
    .optional(),
  environment: z.record(z.string(), z.string()).optional(),
  secretEnv: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  exposed: z.boolean().optional(),
  healthcheck: z.unknown().optional(),
  restart: z.enum(["no", "always", "on-failure", "unless-stopped"]).optional(),
  command: z.string().optional(),
});

const configField = z.object({
  key: z.string(),
  service: z.string(),
  label: z.string(),
  help: z.string().optional(),
  type: z.enum(["text", "password"]).optional(),
  default: z.string().optional(),
  generate: z.enum(["secret", "jwt"]).optional(),
  generateGroup: z.string().optional(),
  jwtSecretGroup: z.string().optional(),
  jwtRole: z.string().optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
});

const prepareStep = z.object({
  service: z.string(),
  command: z.string(),
  capture: z.string(),
  capturePattern: z.string().optional(),
  persistAs: z.object({ key: z.string(), secret: z.boolean().optional() }).optional(),
  once: z.boolean().optional(),
});

const connection = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  outputs: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      help: z.string().optional(),
      source: z.string(),
      secret: z.boolean().optional(),
    }),
  ),
});

const endpoint = z.object({
  service: z.string(),
  port: z.number(),
  label: z.string(),
  kind: z.enum(["http", "tcp"]),
  required: z.boolean().optional(),
});

const file = z.object({
  service: z.string(),
  path: z.string(),
  content: z.string(),
});

export const appTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["template", "flow"]),
  logo: z.string(),
  category: z.enum(["backend", "database", "cms", "mail", "analytics", "automation", "other"]),
  tags: z.array(z.string()).optional(),
  framework: z.string().optional(),
  services: z.array(serviceSpec).optional(),
  configFields: z.array(configField).optional(),
  flowHref: z.string().optional(),
  settings: z.array(z.unknown()).optional(),
  management: z.unknown().optional(),
  prepare: z.array(prepareStep).optional(),
  connection: connection.optional(),
  endpoints: z.array(endpoint).optional(),
  files: z.array(file).optional(),
  available: z.boolean().optional(),
});

/** True if `raw` is a well-formed AppTemplate (shape gate for a remote overlay). */
export function isValidAppTemplate(raw: unknown): boolean {
  return appTemplateSchema.safeParse(raw).success;
}
