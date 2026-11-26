import { Type, type Static } from "@sinclair/typebox";
import { CREDENTIAL_MASK, CONNECTION_OAUTH_PROVIDERS } from "@repo/core";
import { CreateCredentialBody, UpdateCredentialBody } from "./credential-inputs";
import type {
  ResourceOperationSchema,
  ResourceOperations,
  ScopedOperations,
} from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
export const CredentialSchema = Type.Object(
  {
    id: Type.String(),
    provider: Type.String(),
    providerLabel: Type.String(),
    name: Type.String(),
    selector: nullableString,
    publicFields: Type.Record(Type.String(), Type.String()),
    secretsMasked: Type.Record(Type.String(), Type.Literal(CREDENTIAL_MASK)),
    status: Type.String(),
    lastVerifiedAt: nullableString,
    lastError: nullableString,
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type PublicCredential = Static<typeof CredentialSchema>;
export const CredentialProviderSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  icon: Type.String(),
  summary: Type.String(),
  capability: Type.Union([
    Type.Literal("image-pull"),
    Type.Literal("dns"),
    Type.Literal("migration"),
    Type.Literal("git"),
    Type.Literal("server"),
  ]),
  authorization: Type.Optional(
    Type.Object({ available: Type.Boolean(), hostCli: Type.Optional(Type.Boolean()) }),
  ),
  selector: Type.Union([
    Type.Null(),
    Type.Object({
      label: Type.String(),
      required: Type.Boolean(),
      placeholder: Type.Optional(Type.String()),
      help: Type.Optional(Type.String()),
    }),
  ]),
  fields: Type.Array(
    Type.Object({
      key: Type.String(),
      label: Type.String(),
      type: Type.Union([Type.Literal("text"), Type.Literal("secret"), Type.Literal("select")]),
      inputType: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("password")])),
      required: Type.Optional(Type.Boolean()),
      placeholder: Type.Optional(Type.String()),
      help: Type.Optional(Type.String()),
      options: Type.Optional(
        Type.Array(Type.Object({ value: Type.String(), label: Type.String() })),
      ),
    }),
  ),
});
export const CredentialCollectionSchemas = {
  listProviders: { action: "read", output: Type.Array(CredentialProviderSchema) },
  list: { action: "read", output: Type.Array(CredentialSchema) },
  create: { action: "admin", input: CreateCredentialBody, output: CredentialSchema },
  authorize: {
    action: "admin",
    input: Type.Object(
      {
        provider: Type.Union(CONNECTION_OAUTH_PROVIDERS.map((id) => Type.Literal(id))),
        setup: Type.Optional(Type.Literal("new")),
        desktop: Type.Optional(Type.Boolean()),
        name: Type.String({ minLength: 1, maxLength: 100 }),
      },
      { additionalProperties: false },
    ),
    output: Type.Object({ url: Type.String(), state: Type.String() }),
  },
  connectCli: {
    action: "admin",
    input: Type.Object(
      {
        provider: Type.Literal("gitlab"),
        name: Type.String({ minLength: 1, maxLength: 100 }),
      },
      { additionalProperties: false },
    ),
    output: CredentialSchema,
  },
  completeAuthorization: {
    action: "admin",
    input: Type.Object(
      {
        state: Type.String({ minLength: 32, maxLength: 128 }),
        code: Type.String({ minLength: 1, maxLength: 4096 }),
      },
      { additionalProperties: false },
    ),
    output: CredentialSchema,
  },
} as const satisfies Record<string, ResourceOperationSchema>;
export type ConnectionAuthorizationInput = Static<typeof CredentialCollectionSchemas.authorize.input>;
export type CompleteConnectionAuthorizationInput = Static<typeof CredentialCollectionSchemas.completeAuthorization.input>;

export const CredentialResourceSchemas = {
  get: { action: "read", output: CredentialSchema },
  update: { action: "admin", input: UpdateCredentialBody, output: CredentialSchema },
  remove: { action: "admin", output: Type.Object({ success: Type.Literal(true) }) },
  verify: { action: "admin", output: CredentialSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface CredentialOperations
  extends
    ScopedOperations<typeof CredentialCollectionSchemas>,
    ResourceOperations<typeof CredentialResourceSchemas> {}
