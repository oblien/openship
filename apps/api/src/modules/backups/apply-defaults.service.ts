/**
 * Applying an app template's backup defaults to a project — the one click that
 * replaces "open Backup settings, fill the ten-field form, repeat per service".
 *
 * Two callers, one code path: the installer runs this at the tail of a template
 * install, and `POST /projects/:id/backup-policies/apply-defaults` runs it for a
 * project that was installed before any of this existed. Both land on the SAME
 * `createPolicy` the dashboard form posts to, deliberately — that's where cron
 * validation, retention defaulting and `syncPolicySchedule` already live, and a
 * second insert path would be a second place for them to drift out of.
 *
 * Three properties this is built around:
 *
 *   • **It never throws.** A missing destination, a service row that vanished,
 *     a policy that already exists — each is a reported outcome, not an error.
 *     An install must not fail because backups couldn't be arranged; the app is
 *     running and the user can arrange them later.
 *   • **It's idempotent.** Every service already carrying a policy is skipped,
 *     so pressing apply twice creates nothing the second time and can never
 *     collide with the unique index on (project, service).
 *   • **It won't invent a destination.** `destination_id` is NOT NULL, so a
 *     policy needs a real target, and `kind: local` destinations are gated off
 *     by default behind BACKUP_ALLOW_LOCAL_DESTINATION. Auto-provisioning one
 *     would prise open a gate an operator deliberately left shut, so with no
 *     destination in the org this reports `no-destination` and does nothing.
 */

import { repos } from "@repo/db";
import { planAppBackupDefaults, type AppTemplate } from "@repo/core";
import { audit } from "../../lib/audit";
import type { RequestContext } from "../../lib/request-context";
import { createPolicy } from "./backup.service";

/** Why nothing (or not everything) was applied — surfaced to the caller as-is. */
export type ApplyDefaultsReason = "no-destination" | "no-services" | "nothing-to-back-up";

export interface ApplyDefaultsResult {
  /** Policies created by this call. */
  applied: number;
  /** Planned services that already had a policy, or whose row is missing. */
  skipped: number;
  /** Present only when `applied` is 0 and the plan couldn't be carried out. */
  reason?: ApplyDefaultsReason;
  /** Service names that got a policy — for the audit trail and the response. */
  services: string[];
}

/**
 * The destination new policies point at: the caller's explicit choice, else the
 * org's default one, else the oldest one it has.
 *
 * Falling back past `isDefault` to "the only one you have" is deliberate: an org
 * with a single destination and no default flag set has still expressed where
 * its backups go, and refusing on a technicality would make the one click fail
 * for the most common setup there is.
 */
async function resolveDestinationId(
  organizationId: string,
  explicit?: string,
): Promise<string | null> {
  if (explicit) {
    const chosen = await repos.backupDestination.findById(explicit);
    // Cross-org ids are treated as absent rather than as an error: this runs
    // inside an install, and the caller doesn't get to reach into another tenant
    // by passing an id, nor to fail someone's install by passing a bad one.
    if (chosen && chosen.organizationId === organizationId) return chosen.id;
    return null;
  }
  const all = await repos.backupDestination.listByOrganization(organizationId);
  if (all.length === 0) return null;
  return (all.find((d) => d.isDefault) ?? all[0]).id;
}

/**
 * Create the policies `template` implies for `projectId`, skipping services that
 * already have one.
 *
 * `template` is the resolved catalog entry — the caller already has it (the
 * installer is mid-install with it in hand; the endpoint looks it up from the
 * project's app id), so this doesn't re-resolve the catalog.
 */
export async function applyBackupDefaults(
  ctx: RequestContext,
  projectId: string,
  template: AppTemplate,
  opts?: { destinationId?: string },
): Promise<ApplyDefaultsResult> {
  const plan = planAppBackupDefaults(template);
  if (plan.length === 0) {
    return { applied: 0, skipped: 0, reason: "nothing-to-back-up", services: [] };
  }

  const destinationId = await resolveDestinationId(ctx.organizationId, opts?.destinationId);
  if (!destinationId) {
    return { applied: 0, skipped: plan.length, reason: "no-destination", services: [] };
  }

  const rows = await repos.service.listByProject(projectId);
  const idByName = new Map(rows.map((s) => [s.name, s.id]));

  const created: string[] = [];
  let skipped = 0;

  for (const planned of plan) {
    const serviceId = idByName.get(planned.serviceName);
    // The template named a service this project doesn't have — a partial install,
    // or an entry edited after the project was created. Not our problem to fix.
    if (!serviceId) {
      skipped++;
      continue;
    }

    // The user's own policy always wins. This is what makes the retro-apply
    // button safe to press on a project someone has already configured by hand.
    const existing = await repos.backupPolicy.findServiceOverride(projectId, serviceId);
    if (existing) {
      skipped++;
      continue;
    }

    await createPolicy(ctx, {
      projectId,
      serviceId,
      destinationId,
      cronExpression: planned.cronExpression,
      retainCount: planned.retainCount,
      retainDays: planned.retainDays,
      payloadKind: planned.payloadKind,
      payloadConfig: planned.payloadConfig,
      enabled: true,
    });
    created.push(planned.serviceName);
  }

  if (created.length > 0) {
    // One event for the whole apply, not one per policy: the operator-visible
    // action is "backups were set up for this project", and N rows in the audit
    // log for one click reads as noise.
    await audit.record(
      { organizationId: ctx.organizationId, actorUserId: ctx.userId },
      {
        eventType: "backup_policy.defaults_applied",
        resourceType: "project",
        resourceId: projectId,
        after: { appId: template.id, destinationId, services: created },
      },
    );
  }

  return { applied: created.length, skipped, services: created };
}
