/**
 * Apps controller — the one-click app catalog + installer.
 */

import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";
import { getAppCatalog, installApp } from "./app-install.service";
import { getRuntimeTemplate } from "./catalog-source";
import {
  getAppProjectSettings,
  updateAppProjectSettings,
  getAppConnectionView,
  type AppSettingChange,
} from "./app-settings.service";

/** GET /api/apps/catalog — the installable app catalog for the Create-App UI. */
export async function catalog(c: Context) {
  return c.json({ data: getAppCatalog() });
}

/**
 * GET /api/apps/catalog/:id — the full resolved template for one app (from the
 * runtime catalog, so a repo-fresh app the wizard opens is installable without a
 * redeploy). Static config metadata only — no secrets (those are minted at install).
 */
export async function catalogEntry(c: Context) {
  const template = getRuntimeTemplate(param(c, "id"));
  if (!template) return c.json({ error: "Unknown app" }, 404);
  return c.json({ data: template });
}

/** POST /api/apps — install an app from the catalog. */
export async function install(c: Context) {
  const ctx = getRequestContext(c);
  type InstallBody = { templateId?: string; name?: string; config?: Record<string, string> };
  const body = await c.req.json<InstallBody>().catch((): InstallBody => ({}));
  if (!body.templateId) {
    return c.json({ error: "templateId is required" }, 400);
  }
  try {
    const result = await installApp(ctx, {
      templateId: body.templateId,
      name: body.name,
      config: body.config,
    });
    return c.json({ data: result });
  } catch (err) {
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
