/**
 * Monitor validation schemas — TypeBox for Hono route validation.
 *
 * A monitor is a per-project HTTP probe run by the monitor runner
 * (lib/monitor-runner). Bounds mirror the DB defaults: interval ≥ 30s,
 * timeout 1–30s, threshold 1–10.
 */

import { Type, type Static } from "@sinclair/typebox";

export const CreateMonitorBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  /** Probed URL — http(s) only. Private/internal hosts are allowed
   *  (self-hosted only; matches the webhook-channel precedent). */
  url: Type.String({ minLength: 1, maxLength: 2000, pattern: "^https?://" }),
  intervalSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 86_400 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 30_000 })),
  /** Exact status code required for success. Null/omitted = any status < 400. */
  expectedStatus: Type.Optional(
    Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
  ),
  /** Consecutive failures before the monitor flips to "down". */
  failureThreshold: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  enabled: Type.Optional(Type.Boolean()),
});

export type TCreateMonitorBody = Static<typeof CreateMonitorBody>;

export const UpdateMonitorBody = Type.Partial(CreateMonitorBody);

export type TUpdateMonitorBody = Static<typeof UpdateMonitorBody>;
