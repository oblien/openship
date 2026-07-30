/**
 * Docker Swarm discovery route contracts.
 *
 * These routes intentionally have no request body: the only target is an
 * existing, authorized server id in the path. Keeping the contract read-only
 * prevents this module from becoming an accidental Docker command surface.
 */

import { Type, type Static } from "@sinclair/typebox";

export const SwarmServerParams = Type.Object({
  serverId: Type.String({ minLength: 1, maxLength: 128 }),
});

export const SwarmStackParams = Type.Intersect([
  SwarmServerParams,
  Type.Object({
    stackName: Type.String({ minLength: 1, maxLength: 128 }),
  }),
]);

export type TSwarmServerParams = Static<typeof SwarmServerParams>;
export type TSwarmStackParams = Static<typeof SwarmStackParams>;
