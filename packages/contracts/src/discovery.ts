import { Type, type Static } from "@sinclair/typebox";

const nullableString = Type.Union([Type.String(), Type.Null()]);

/** Enable/disable server discovery. */
export const DiscoveryConfigureInputSchema = Type.Object(
  {
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type DiscoveryConfigureInput = Static<typeof DiscoveryConfigureInputSchema>;

/** Operator intent on one discovered service. */
export const DiscoveryServiceActionInputSchema = Type.Object(
  {
    serviceKey: Type.String({ minLength: 1, description: 'Stable discovery identity, e.g. "id:my-app"' }),
  },
  { additionalProperties: false },
);
export type DiscoveryServiceActionInput = Static<typeof DiscoveryServiceActionInputSchema>;

export const DiscoverySettingsSchema = Type.Object({
  serverId: Type.String(),
  enabled: Type.Boolean(),
  workspaceId: nullableString,
  sweepIntervalSeconds: Type.Number(),
  lastScanAt: nullableString,
  lastScanError: nullableString,
});
export type DiscoverySettings = Static<typeof DiscoverySettingsSchema>;

/** Route/TLS state for one discovered service (binding + its server-scoped domain). */
export const DiscoveryServiceSchema = Type.Object({
  id: Type.String(),
  serviceKey: Type.String(),
  composeProject: nullableString,
  composeService: nullableString,
  hostname: Type.String(),
  port: Type.Number(),
  networkName: nullableString,
  /** observed | missing | error | invalid */
  observationStatus: Type.String(),
  containerName: nullableString,
  containerRunning: Type.Boolean(),
  /** network-ip | published-port | null (not resolved yet) */
  upstreamStrategy: nullableString,
  ipAddress: nullableString,
  hostPort: nullableString,
  /** pending | applied | error | blocked */
  applyState: Type.String(),
  applyError: nullableString,
  applyAttempts: Type.Number(),
  nextApplyAt: nullableString,
  /** A confirmed route exists that must be retired (backend removed/invalidated). */
  withdrawalPending: Type.Boolean(),
  suppressed: Type.Boolean(),
  /** desired vs applied generation: a gap means reconciliation is in flight. */
  desiredGeneration: Type.Number(),
  appliedGeneration: Type.Number(),
  updatedAt: nullableString,
  /** The server-scoped domain backing the TLS lifecycle (missing until first apply). */
  tls: Type.Union([
    Type.Object({
      hostname: Type.String(),
      verified: Type.Boolean(),
      /** none | pending | issued | error ... — the domain row's own ssl state. */
      sslStatus: Type.String(),
      sslExpiresAt: nullableString,
      sslIssuer: nullableString,
    }),
    Type.Null(),
  ]),
});
export type DiscoveryService = Static<typeof DiscoveryServiceSchema>;

export const DiscoveryStatusSchema = Type.Object({
  settings: DiscoverySettingsSchema,
  services: Type.Array(DiscoveryServiceSchema),
});
export type DiscoveryStatus = Static<typeof DiscoveryStatusSchema>;

/** Result of one full (fresh) sweep of one server. */
export const DiscoveryRescanSchema = Type.Object({
  serverId: Type.String(),
  failed: Type.Array(Type.String()),
  scan: Type.Union([Type.Object({ scanned: Type.Number(), ok: Type.Boolean() }), Type.Null()]),
  reconcile: Type.Union([
    Type.Object({
      applied: Type.Array(Type.String()),
      removed: Type.Array(Type.String()),
      retained: Type.Array(Type.String()),
      withdrawals: Type.Array(Type.String()),
      failed: Type.Array(Type.Object({ serviceKey: Type.String(), reason: Type.String() })),
      ok: Type.Boolean(),
    }),
    Type.Null(),
  ]),
  repair: Type.Union([
    Type.Object({
      scanned: Type.Number(),
      repaired: Type.Array(Type.String()),
      retained: Type.Array(Type.String()),
      requeued: Type.Array(Type.String()),
      failed: Type.Array(Type.Object({ serviceKey: Type.String(), reason: Type.String() })),
    }),
    Type.Null(),
  ]),
});
export type DiscoveryRescan = Static<typeof DiscoveryRescanSchema>;
