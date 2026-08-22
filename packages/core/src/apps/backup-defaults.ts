/**
 * Turning an app template into the backup policies it should have on day one.
 *
 * The gap this closes: installing an app is one click, but until now protecting
 * what it stores was the ten-field policy form, once per service — so a fresh
 * PostHog (six services with volumes) meant six hand-built policies before any
 * of its data was covered. Nothing derived a policy from what an app IS.
 *
 * Two decisions make that derivable rather than something 24 catalog entries
 * have to spell out:
 *
 *   • **A volume is the stateful signal.** Every entry already declares its
 *     volumes because they're what the compose file needs; a service with one
 *     holds state worth keeping and a service without one is rebuildable from
 *     its image. So the catalog needs no new field to say "back me up".
 *   • **"auto" already knows what to run.** `payload_kind: "auto"` resolves
 *     through the producer registry's `detect()` chain
 *     (packages/adapters/src/backup/registry.ts), which picks pg_dump for a
 *     Postgres service, mysql_dump for MySQL, mongo_dump, redis_rdb, and falls
 *     back to a volume copy. A derived plan therefore doesn't have to guess a
 *     producer per image — it defers, and the same lookup the manual path uses
 *     decides at run time.
 *
 * The template's optional `backup` block exists only to CORRECT this: skip a
 * rebuildable cache volume, pin a producer derivation would get wrong, widen
 * retention on the one service that matters. An app that agrees with derivation
 * writes nothing.
 *
 * Everything here is pure — no DB, no clock, no I/O — so the interesting cases
 * are unit-testable, and the apps/api applier stays a thin translation from this
 * plan into the existing `createPolicy`.
 */

import type { AppTemplate, AppBackupServiceRule } from "../app-templates";
import { DEFAULT_BACKUP_HOUR, DEFAULT_BACKUP_MINUTE, DEFAULT_RETAIN_COUNT } from "../constants";

/** Minutes between two services' scheduled starts within the same app. */
const STAGGER_MINUTES = 7;

/** Wrap into the hour so a big app can't schedule at minute 61. */
const MINUTES_PER_HOUR = 60;

/**
 * One policy to create, in the shape `createPolicy` wants. `serviceName` (not an
 * id) because this is computed from the template, before service rows exist —
 * the applier resolves names to ids.
 */
export interface PlannedBackupDefault {
  serviceName: string;
  /** Registry kind, or "auto" to let `detect()` choose. */
  payloadKind: string;
  payloadConfig: Record<string, unknown>;
  cronExpression: string;
  /** null = unlimited, deliberately (same distinction createPolicy draws). */
  retainCount: number | null;
  retainDays: number | null;
  /** True when a `backup` rule contributed anything — lets a caller tell an
   *  authored policy from a purely derived one when reporting what it did. */
  authored: boolean;
}

/**
 * The nightly cron for the Nth service of an app, staggered off the shared
 * default time.
 *
 * Staggering matters more than it looks: a six-service app whose policies all
 * said "03:17" would start six dumps in the same minute, on one box, each of
 * them competing for the same disk and the same upload bandwidth — which is how
 * a backup window turns into an outage. Seven-minute steps spread PostHog's six
 * across 03:17–04:02 while keeping every one of them inside the quiet hours.
 */
export function staggeredCron(index: number): string {
  const total =
    DEFAULT_BACKUP_HOUR * MINUTES_PER_HOUR + DEFAULT_BACKUP_MINUTE + index * STAGGER_MINUTES;
  const hour = Math.floor(total / MINUTES_PER_HOUR) % 24;
  const minute = total % MINUTES_PER_HOUR;
  return `${minute} ${hour} * * *`;
}

/** Does this service hold state worth backing up? */
function isStateful(service: { volumes?: readonly string[] }): boolean {
  return (service.volumes ?? []).length > 0;
}

/**
 * The policies an app should come out of install with.
 *
 * Order is the template's own service order, so the stagger is stable for a
 * given entry — reinstalling the same app produces the same schedule rather
 * than shuffling it.
 */
export function planAppBackupDefaults(template: AppTemplate): PlannedBackupDefault[] {
  const rules = new Map<string, AppBackupServiceRule>();
  for (const rule of template.backup?.services ?? []) rules.set(rule.service, rule);

  const services = template.services ?? [];
  const plan: PlannedBackupDefault[] = [];

  for (const service of services) {
    const rule = rules.get(service.name);

    // An explicit skip wins over everything, including a volume.
    if (rule?.skip) continue;

    // In scope when it holds state, OR when the app explicitly asked for it —
    // that second half is what lets an app back up a service whose data doesn't
    // live in a declared volume (a dump piped out of a socket, say).
    if (!isStateful(service) && !rule) continue;

    plan.push({
      serviceName: service.name,
      payloadKind: rule?.payloadKind ?? "auto",
      payloadConfig: rule?.payloadConfig ? { ...rule.payloadConfig } : {},
      // Stagger by POSITION IN THE PLAN, not by index in `services`: skipped and
      // stateless services shouldn't burn a slot and leave gaps in the schedule.
      cronExpression: rule?.cronExpression ?? staggeredCron(plan.length),
      // `undefined` and `null` mean different things here and both are reachable:
      // omitted ⇒ the shared default, explicit null ⇒ unlimited.
      retainCount:
        rule && "retainCount" in rule ? (rule.retainCount ?? null) : DEFAULT_RETAIN_COUNT,
      retainDays: rule?.retainDays ?? null,
      authored: !!rule,
    });
  }

  return plan;
}
