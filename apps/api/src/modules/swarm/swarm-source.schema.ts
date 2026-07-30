import { Type, type Static } from "@sinclair/typebox";

const SourceVersion = Type.Integer({ minimum: 1 });

export const UpdateSwarmStackSourceBody = Type.Union([
  Type.Object({
    kind: Type.Literal("inline"),
    yaml: Type.String({ minLength: 1, maxLength: 1_000_000 }),
    expectedVersion: SourceVersion,
  }),
  Type.Object({
    kind: Type.Literal("repository"),
    composePaths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 20 }),
    sourcePath: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    branch: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    commitSha: Type.Optional(Type.String({ minLength: 7, maxLength: 64 })),
    expectedVersion: SourceVersion,
  }),
  Type.Object({
    kind: Type.Literal("adopted"),
    expectedVersion: SourceVersion,
  }),
]);

export type TUpdateSwarmStackSourceBody = Static<typeof UpdateSwarmStackSourceBody>;

/** Explicit render interpolation only; values are never persisted or echoed. */
export const RenderSwarmStackSourceBody = Type.Object({
  environment: Type.Optional(Type.Record(
    Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 128 }),
    Type.String({ maxLength: 16_384 }),
    { maxProperties: 100 },
  )),
});

export type TRenderSwarmStackSourceBody = Static<typeof RenderSwarmStackSourceBody>;

/** Strong confirmation for the first write to an observed Swarm stack. */
export const ClaimSwarmStackBody = Type.Object({
  confirmedStackName: Type.String({ minLength: 1, maxLength: 63 }),
  previewLiveDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
});

export type TClaimSwarmStackBody = Static<typeof ClaimSwarmStackBody>;

/** An explicit runtime replica override, optionally persisted into inline source. */
export const ScaleSwarmServiceBody = Type.Object({
  replicas: Type.Integer({ minimum: 0, maximum: 10_000 }),
  persistence: Type.Union([Type.Literal("temporary"), Type.Literal("inline-source")]),
});

export type TScaleSwarmServiceBody = Static<typeof ScaleSwarmServiceBody>;

/** Typed-name confirmation before removing an entire managed stack. */
export const RemoveSwarmStackBody = Type.Object({
  confirmedStackName: Type.String({ minLength: 1, maxLength: 63 }),
});

export type TRemoveSwarmStackBody = Static<typeof RemoveSwarmStackBody>;

/** Typed-name confirmation before returning a stack to another controller. */
export const ReleaseSwarmManagementBody = Type.Object({
  confirmedStackName: Type.String({ minLength: 1, maxLength: 63 }),
});

export type TReleaseSwarmManagementBody = Static<typeof ReleaseSwarmManagementBody>;

/** Bind an as-yet absent stack name to an existing OpenShip project. */
export const CreateSwarmStackBindingBody = Type.Object({
  serverId: Type.String({ minLength: 1 }),
  stackName: Type.String({ minLength: 1, maxLength: 63 }),
});

export type TCreateSwarmStackBindingBody = Static<typeof CreateSwarmStackBindingBody>;
