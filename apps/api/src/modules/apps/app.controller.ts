/**
 * Apps controller — the one-click app catalog + installer.
 */

import type { Context } from "hono";
import { AppError } from "@repo/core";
import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";
import {
  getAppCatalog,
  installApp,
  findOpenAppDraft,
  type InstallAppRoute,
} from "./app-install.service";
import { getTemplateForOrg } from "./catalog-source";
import { saveCustomApp, listCustomApps, deleteCustomApp } from "./custom-app.service";
import {
  getAppProjectSettings,
  updateAppProjectSettings,
  getAppConnectionView,
  type AppSettingChange,
} from "./app-settings.service";

/** GET /api/apps/catalog — the installable app catalog for the Create-App UI
 *  (curated + this org's custom apps). */
export async function catalog(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await getAppCatalog(ctx) });
}

/**
 * GET /api/apps/catalog/:id — the full resolved template for one app (curated or
 * this org's custom app), so the wizard opens it without a redeploy. Static
 * config metadata only — no secrets (those are minted at install).
 *
 * Also reports this org's OPEN (never-deployed) draft of the app, because an
 * install request for the same name adopts that draft: the wizard has to show the
 * draft's stored configuration rather than template defaults, or Install quietly
 * changes what the operator set up last time.
 */
export async function catalogEntry(c: Context) {
  const ctx = getRequestContext(c);
  const template = await getTemplateForOrg(ctx.organizationId, param(c, "id"));
  if (!template) return c.json({ error: "Unknown app" }, 404);
  return c.json({ data: template, draft: await findOpenAppDraft(ctx, template.id) });
}

/** POST /api/apps/custom — validate + store an uploaded app JSON as a per-org
 *  (unverified) custom app. Returns its id; then it appears in the catalog. */
export async function addCustom(c: Context) {
  const ctx = getRequestContext(c);
  const raw = await c.req.json<unknown>().catch(() => null);
  if (raw == null || typeof raw !== "object") {
    return c.json({ error: "Upload a JSON app definition." }, 400);
  }
  try {
    return c.json({ data: await saveCustomApp(ctx, raw) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Invalid app definition." }, 400);
  }
}

/** GET /api/apps/custom — this org's custom apps. */
export async function listCustom(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await listCustomApps(ctx) });
}

/** DELETE /api/apps/custom/:appId — remove a custom app from this org's catalog. */
export async function removeCustom(c: Context) {
  const ctx = getRequestContext(c);
  await deleteCustomApp(ctx, param(c, "appId"));
  return c.json({ data: { ok: true } });
}

/** POST /api/apps — install an app from the catalog. */
export async function install(c: Context) {
  const ctx = getRequestContext(c);
  type InstallBody = {
    templateId?: string;
    name?: string;
    config?: Record<string, string>;
    routes?: InstallAppRoute[];
  };
  const body = await c.req.json<InstallBody>().catch((): InstallBody => ({}));
  if (!body.templateId) {
    return c.json({ error: "templateId is required" }, 400);
  }
  try {
    const result = await installApp(ctx, {
      templateId: body.templateId,
      name: body.name,
      config: body.config,
      routes: body.routes,
    });
    return c.json({ data: result });
  } catch (err) {
    // A typed failure carries its own status + wire code (e.g. the free-domain
    // CLOUD_REQUIRED_* 403 the dashboard maps back to a connect prompt) — let the
    // central handler serialize it instead of flattening it to a bare 400.
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "Failed to install app";
    return c.json({ error: message }, 400);
  }
}

/** GET /api/projects/:id/app-settings — curated settings schema + current values. */
export async function getSettings(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await getAppProjectSettings(ctx, param(c, "id")) });
}

/** PATCH /api/projects/:id/app-settings — update curated settings (safe env merge). */
export async function patchSettings(c: Context) {
  const ctx = getRequestContext(c);
  type Body = { changes?: AppSettingChange[] };
  const body = await c.req.json<Body>().catch((): Body => ({}));
  const changes = Array.isArray(body.changes) ? body.changes : [];
  return c.json({ data: await updateAppProjectSettings(ctx, param(c, "id"), changes) });
}

/** GET /api/projects/:id/app-connection — resolved connection details (URLs + keys). */
export async function getConnection(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await getAppConnectionView(ctx, param(c, "id")) });
}
