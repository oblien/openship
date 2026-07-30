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

/** Cutover is maintenance-window-only and bound to a fresh read-only plan. */
export const SwarmEdgeCutoverBody = Type.Object({
  serviceId: Type.String({ minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9]+$" }),
  specVersion: Type.Integer({ minimum: 1 }),
  confirmedServiceName: Type.String({ minLength: 1, maxLength: 256 }),
  maintenanceWindowAcknowledged: Type.Literal(true),
});

export type TSwarmEdgeCutoverBody = Static<typeof SwarmEdgeCutoverBody>;

export const SwarmEdgeCutoverRecoveryBody = Type.Object({
  maintenanceWindowAcknowledged: Type.Literal(true),
});

export type TSwarmEdgeCutoverRecoveryBody = Static<typeof SwarmEdgeCutoverRecoveryBody>;
