/**
 * Service validation schemas.
 */

import { Type, type Static } from "@sinclair/typebox";

export const ServiceIdParam = Type.Object({
  id: Type.String({ minLength: 1 }),
  serviceId: Type.String({ minLength: 1 }),
});

export const ProjectIdParam = Type.Object({
  id: Type.String({ minLength: 1 }),
});

export const UpdateServiceBody = Type.Object({
  image: Type.Optional(Type.String({ maxLength: 500 })),
  build: Type.Optional(Type.String({ maxLength: 500 })),
  dockerfile: Type.Optional(Type.String({ maxLength: 500 })),
  ports: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 50 })),
  environment: Type.Optional(Type.Record(Type.String(), Type.String())),
  volumes: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 })),
  command: Type.Optional(Type.String({ maxLength: 1000 })),
  exposed: Type.Optional(Type.Boolean()),
  exposedPort: Type.Optional(Type.String({ maxLength: 50 })),
  domain: Type.Optional(Type.String({ maxLength: 255 })),
  customDomain: Type.Optional(Type.String({ maxLength: 255 })),
  domainType: Type.Optional(
    Type.Union([
      Type.Literal("free"),
      Type.Literal("custom"),
    ]),
  ),
  restart: Type.Optional(
    Type.Union([
      Type.Literal("no"),
      Type.Literal("always"),
      Type.Literal("on-failure"),
      Type.Literal("unless-stopped"),
    ]),
  ),
  enabled: Type.Optional(Type.Boolean()),
  sortOrder: Type.Optional(Type.Number({ minimum: 0 })),
});

export const SetServiceEnvVarsBody = Type.Object({
  environment: Type.Union([
    Type.Literal("production"),
    Type.Literal("preview"),
    Type.Literal("development"),
  ]),
  vars: Type.Array(
    Type.Object({
      key: Type.String({ minLength: 1, maxLength: 256 }),
      value: Type.String({ maxLength: 10000 }),
      isSecret: Type.Optional(Type.Boolean({ default: false })),
    }),
    { minItems: 0, maxItems: 100 },
  ),
});

export type TUpdateServiceBody = Static<typeof UpdateServiceBody>;
export type TSetServiceEnvVarsBody = Static<typeof SetServiceEnvVarsBody>;
