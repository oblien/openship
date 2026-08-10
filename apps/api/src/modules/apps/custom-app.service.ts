/**
 * Custom (user-uploaded) apps — a per-org catalog entry from an uploaded JSON.
 *
 * Trust is PROVENANCE-based, never read from the JSON: an upload is always
 * UNVERIFIED (`verified` + `available` are forced here, so a file claiming
 * `"verified": true` is ignored). The definition is validated by the SAME strict
 * schema as the curated catalog (shape + referential), can't be a `flow` app, and
 * can't shadow a built-in id. It installs through the normal services pipeline —
 * same in-container boundary as any user-authored project, no new privilege.
 */

import { parseAppTemplate, ValidationError, type AppTemplate } from "@repo/core";
import { repos } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { getRuntimeTemplate } from "./catalog-source";

export interface CustomAppSummary {
  appId: string;
  name: string;
  updatedAt: string;
}

/** Validate + store an uploaded app JSON as this org's custom app. Returns its id. */
export async function saveCustomApp(ctx: RequestContext, raw: unknown): Promise<{ appId: string }> {
  const decision = parseAppTemplate(raw);
  if (!decision.ok) {
    throw new ValidationError(
      decision.reason === "schema-too-new"
        ? "This app targets a newer catalog schema than this Openship version supports."
        : `Invalid app definition${decision.detail ? `: ${decision.detail}` : ""}.`,
    );
  }
  const tpl = raw as AppTemplate;
  if (tpl.kind !== "template") {
    throw new ValidationError("Only template apps can be added as custom apps (flow apps aren't supported).");
  }
  if (getRuntimeTemplate(tpl.id)) {
    throw new ValidationError(
      `"${tpl.id}" is a built-in app id — rename your custom app's id to something unique.`,
    );
  }
  // Provenance-based trust: the system decides verified/available, never the file.
  const stored: AppTemplate = { ...tpl, verified: false, available: true };
  await repos.customAppTemplate.upsert({
    organizationId: ctx.organizationId,
    appId: tpl.id,
    template: stored,
    createdByUserId: ctx.userId,
  });
  return { appId: tpl.id };
}

export async function listCustomApps(ctx: RequestContext): Promise<CustomAppSummary[]> {
  const rows = await repos.customAppTemplate.listByOrg(ctx.organizationId);
  return rows.map((r) => ({
    appId: r.appId,
    name: r.template.name,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function deleteCustomApp(ctx: RequestContext, appId: string): Promise<void> {
  await repos.customAppTemplate.deleteByAppId(ctx.organizationId, appId);
}
