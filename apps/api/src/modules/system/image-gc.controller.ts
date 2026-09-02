/**
 * Built-image GC controller — /api/system/image-gc.
 *
 * The operator-facing side of the `images:gc` system job (see
 * modules/deployments/image-gc.ts). `plan` is a strictly read-only dry run: every
 * project's built images on its deploy host with the decision the sweep WOULD
 * take and why (active, pinned, rollback window, in use, operator-retagged,
 * superseded), the rollback window that decided it, and the bytes a run would
 * reclaim — so "why is this image still here" and "what is safe to remove" are
 * answerable without reaching for `docker system prune` (#779). `run` is the
 * same sweep the schedule fires, recorded as a manual `images:gc` job run so it
 * shows in job history next to the scheduled ticks.
 *
 * Both accept `olderThan` (`30d`, `12h`, …): only remove superseded images at
 * least that old. Age never overrides the keep-set — it can only narrow a run.
 *
 * Instance-admin only: the sweep spans every organisation's projects and hosts,
 * and the plan reveals them.
 */

import type { Context } from "hono";
import { Type } from "@sinclair/typebox";
import { assertNotCloud } from "../../lib/controller-helpers";
import { recordJobRun } from "../../lib/system-jobs";
import {
  IMAGE_GC_JOB_KEY,
  imageGcJobSummary,
  parseMinAge,
  planImageGc,
  runImageGcSweep,
} from "../deployments/image-gc";

export const ImageGcRunBody = Type.Object({
  /** e.g. "30d", "12h" — see parseMinAge. */
  olderThan: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
});

/** GET /system/image-gc/plan?olderThan=30d — dry run, changes nothing. */
export async function plan(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;
  const olderThan = c.req.query("olderThan");
  const minAgeMs = olderThan ? parseMinAge(olderThan) : undefined;
  return c.json({ data: await planImageGc({ minAgeMs }) });
}

/** POST /system/image-gc/run — the sweep, recorded as a manual job run. */
export async function run(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;
  const body = await c.req.json<{ olderThan?: string }>();
  const minAgeMs = body.olderThan ? parseMinAge(body.olderThan) : undefined;
  const summary = await recordJobRun(IMAGE_GC_JOB_KEY, { trigger: "manual" }, async () =>
    imageGcJobSummary(await runImageGcSweep({ minAgeMs })),
  );
  return c.json({ data: { key: IMAGE_GC_JOB_KEY, minAgeMs: minAgeMs ?? null, summary } });
}
