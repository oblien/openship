/**
 * GitLab validation schemas.
 */

import { Type, type Static } from "@sinclair/typebox";

export const ProjectIdParams = Type.Object({
  projectId: Type.String({ minLength: 1 }),
});

export const ConnectBody = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal("oauth"), Type.Literal("pat")])),
  token: Type.Optional(Type.String({ minLength: 1 })),
});

export const DisconnectBody = Type.Object({
  source: Type.Optional(
    Type.Union([Type.Literal("oauth"), Type.Literal("pat"), Type.Literal("all")]),
  ),
});

export type TProjectIdParams = Static<typeof ProjectIdParams>;
export type TConnectBody = Static<typeof ConnectBody>;
export type TDisconnectBody = Static<typeof DisconnectBody>;
