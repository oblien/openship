import { Type } from "@sinclair/typebox";

/**
 * Request-body schemas for the settings PATCH routes. Declared once and wired
 * via `spec.body` so they both auto-validate and type the MCP tool. Enum values
 * mirror the controller's VALID_* guards (settings.controller / settings.service).
 */

/** PATCH /build-mode */
export const UpdateBuildModeBody = Type.Object({
  buildMode: Type.Union([Type.Literal("auto"), Type.Literal("server"), Type.Literal("local")], {
    description: "Default build mode.",
  }),
});

/** PATCH /route-strategy */
export const UpdateRouteStrategyBody = Type.Object({
  routeStrategy: Type.Union(
    [Type.Literal("auto"), Type.Literal("loopback-port"), Type.Literal("container-ip")],
    { description: "Default edge→app route strategy." },
  ),
});

/** PATCH /deploy-defaults — all optional; pass null to clear. */
export const UpdateDeployDefaultsBody = Type.Object({
  defaultDeployTarget: Type.Optional(
    Type.Union([Type.Literal("local"), Type.Literal("server"), Type.Literal("cloud"), Type.Null()], {
      description: "Default deploy target, or null to clear.",
    }),
  ),
  defaultServerId: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "Default server id (required when target='server'; forced null otherwise).",
    }),
  ),
});

/** PATCH /clone-strategy-preference */
export const UpdateCloneStrategyPreferenceBody = Type.Object({
  preference: Type.Union(
    [Type.Literal("prompt"), Type.Literal("local"), Type.Literal("remote-with-token")],
    { description: "Default clone strategy nudge choice." },
  ),
});

/** PATCH /transfer — all optional; sets whichever field is present. */
export const UpdateTransferPrefsBody = Type.Object({
  transferMode: Type.Optional(
    Type.Union(
      [Type.Literal("auto"), Type.Literal("stream"), Type.Literal("direct"), Type.Literal("rsync")],
      { description: "Default volume-transfer mode for migrations." },
    ),
  ),
  transferCompression: Type.Optional(
    Type.Union(
      [Type.Literal("auto"), Type.Literal("zstd"), Type.Literal("gzip"), Type.Literal("none")],
      { description: "Default volume-transfer compression." },
    ),
  ),
});

/** PATCH /forward-git */
export const UpdateForwardGitBody = Type.Object({
  enabled: Type.Boolean({ description: "Forward the local git identity to remote build servers." }),
});
