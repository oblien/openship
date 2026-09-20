import { Type, type Static } from "@sinclair/typebox";
import { ResourceIdSchema } from "./deployment-resources";

const port = Type.Integer({ minimum: 1, maximum: 65535 });
export const ServerTunnelSchema = Type.Object(
  {
    id: Type.String(),
    serverId: Type.String(),
    remoteHost: Type.String(),
    remotePort: port,
    localPort: Type.Union([Type.Integer({ minimum: 0, maximum: 65535 }), Type.Null()]),
    autoStart: Type.Boolean(),
    running: Type.Boolean(),
    activeConnections: Type.Integer({ minimum: 0 }),
    url: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type ServerTunnel = Static<typeof ServerTunnelSchema>;

/** Numeric strings remain accepted for compatibility with existing desktop callers. */
export const SaveServerTunnelInputSchema = Type.Object(
  {
    remotePort: Type.Union([port, Type.String({ minLength: 1 })]),
    remoteHost: Type.Optional(Type.String({ maxLength: 253 })),
    localPort: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0, maximum: 65535 }), Type.String(), Type.Null()]),
    ),
    autoStart: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const ServerTunnelInputSchema = Type.Object(
  { tunnelId: ResourceIdSchema },
  { additionalProperties: false },
);
export const StartServerTunnelResultSchema = Type.Union([
  ServerTunnelSchema,
  Type.Object(
    {
      tunnelId: Type.String(),
      serverId: Type.String(),
      remoteHost: Type.String(),
      remotePort: port,
      localPort: port,
      activeConnections: Type.Integer({ minimum: 0 }),
      url: Type.String(),
    },
    { additionalProperties: false },
  ),
]);
