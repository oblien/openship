/**
 * Azure DevOps HTTP handlers — per-organization PAT connections.
 * Every route resolves the tenant from the request context, never from input.
 */

import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { getConnection } from "@repo/platform/engine/modules/azure/azure.auth";
import * as azureService from "@repo/platform/engine/modules/azure/azure.service";
import { resolveProjectInfo } from "@repo/platform/engine/modules/deployments/prepare.service";

function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

export async function getStatus(c: Context) {
  const ctx = getRequestContext(c);
  const connections = await repos.azureConnection.listByOrganization(ctx.organizationId);
  return c.json({
    connected: connections.length > 0,
    connections: connections.map((conn) => ({
      adoOrg: conn.adoOrg,
      status: conn.status,
      patSetAt: conn.patSetAt,
    })),
  });
}

export async function saveToken(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ token?: string; organization?: string }>().catch(() => null);
  const token = body?.token?.trim() ?? "";
  const organization = azureService.normalizeAzureOrganization(body?.organization ?? "");

  if (!token) {
    return c.json({ error: "A personal access token is required", code: "AZURE_PAT_REQUIRED" }, 400);
  }
  if (!organization) {
    return c.json(
      {
        error:
          "An Azure DevOps organization is required. Org-scoped PATs cannot list accounts, so Openship cannot guess it.",
        code: "AZURE_ORG_REQUIRED",
      },
      400,
    );
  }

  try {
    await azureService.verifyPatCanReadOrganization(token, organization);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Azure DevOps rejected this PAT";
    return c.json({ error: message, code: "AZURE_ORG_UNREACHABLE" }, 400);
  }

  await azureService.saveConnection(ctx, organization, token);
  return c.json({ success: true, adoOrg: organization });
}

export async function deleteConnection(c: Context) {
  const ctx = getRequestContext(c);
  const org = azureService.normalizeAzureOrganization(param(c, "org"));
  if (!org) return c.json({ error: "Invalid Azure DevOps organization" }, 400);
  const deleted = await azureService.deleteConnection(ctx, org);
  return c.json({ success: true, deleted });
}

export async function listOrgs(c: Context) {
  const ctx = getRequestContext(c);
  const connections = await repos.azureConnection.listActiveByOrganization(ctx.organizationId);
  return c.json({ orgs: connections.map((conn) => conn.adoOrg) });
}

/** Shared guard: the URL-named Azure DevOps org must be connected for this tenant. */
async function assertConnected(c: Context, org: string) {
  const ctx = getRequestContext(c);
  const conn = await getConnection(ctx.organizationId, org);
  if (!conn || conn.status === "invalid") {
    throw Object.assign(new Error(`Azure DevOps organization "${org}" is not connected`), {
      status: 400,
    });
  }
  return ctx;
}

export async function listRepos(c: Context) {
  const ctx = await assertConnected(c, param(c, "org"));
  const repos = await azureService.listRepos(ctx, param(c, "org"));
  return c.json({
    repos: repos.map((r) => ({
      id: r.id,
      name: r.name,
      org: r.org,
      project: r.project,
      full_name: `${r.org}/${r.project}/${r.name}`,
      default_branch: r.defaultBranch,
      html_url: r.webUrl,
      private: true,
    })),
  });
}

export async function listBranches(c: Context) {
  const ctx = await assertConnected(c, param(c, "org"));
  const branches = await azureService.listBranches(
    ctx,
    param(c, "org"),
    param(c, "project"),
    param(c, "repo"),
  );
  return c.json({ branches });
}

export async function detectStack(c: Context) {
  const ctx = await assertConnected(c, param(c, "org"));
  const org = param(c, "org");
  const project = param(c, "project");
  const repo = param(c, "repo");
  const branch = c.req.query("branch") || undefined;
  const info = await resolveProjectInfo({
    source: "azure",
    owner: org,
    project,
    repo,
    branch,
    ctx,
  });
  return c.json(info);
}

export async function registerWebhook(c: Context) {
  const ctx = await assertConnected(c, param(c, "org"));
  const org = param(c, "org");
  const projectName = param(c, "project");
  const repo = param(c, "repo");
  const secret = randomBytes(32).toString("hex");
  const { subscriptionId } = await azureService.registerServiceHook(
    ctx,
    org,
    projectName,
    repo,
    secret,
  );
  return c.json({ subscriptionId });
}

export async function deleteWebhook(c: Context) {
  const ctx = await assertConnected(c, param(c, "org"));
  const subscriptionId = c.req.query("subscriptionId");
  if (!subscriptionId) return c.json({ error: "subscriptionId is required" }, 400);
  await azureService.deleteServiceHook(ctx, param(c, "org"), subscriptionId);
  return c.json({ success: true });
}
