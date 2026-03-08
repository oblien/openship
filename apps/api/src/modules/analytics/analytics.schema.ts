/**
 * Analytics schemas — TypeBox validation for analytics endpoints.
 */

import { Type, type Static } from "@sinclair/typebox";

// ─── Query params ────────────────────────────────────────────────────────────

export const AnalyticsQuery = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  /** ISO date string — start of range */
  from: Type.Optional(Type.String()),
  /** ISO date string — end of range */
  to: Type.Optional(Type.String()),
  /** Include live (real-time) data from the running container */
  live: Type.Optional(Type.Boolean({ default: false })),
});

export const UsageQuery = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  /** ISO date string — start of range */
  from: Type.Optional(Type.String()),
  /** ISO date string — end of range */
  to: Type.Optional(Type.String()),
  /** Bucket size in minutes for time-series data (min 10) */
  bucketMinutes: Type.Optional(Type.Number({ minimum: 10, default: 60 })),
});

export const UsageStreamQuery = Type.Object({
  projectId: Type.String({ minLength: 1 }),
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TAnalyticsQuery = Static<typeof AnalyticsQuery>;
export type TUsageQuery = Static<typeof UsageQuery>;
export type TUsageStreamQuery = Static<typeof UsageStreamQuery>;
