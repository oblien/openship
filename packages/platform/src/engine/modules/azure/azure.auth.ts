/**
 * Azure DevOps credentials — per-organization PAT connections.
 *
 * Every credential belongs to ONE panel organization (the tenant that saved
 * it) and is scoped to ONE Azure DevOps organization. There is no instance-wide
 * token and no login-identity reuse: a deployment must never depend on who is
 * logged in, and two tenants on the same panel must never share read access.
 *
 * Tokens are never written into gitUrl — clone-time injection only.
 */

import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import type { AzureConnection } from "@repo/db";
import { decrypt, encrypt } from "../../lib/encryption";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { adoOrgFromUrl, authHeader } from "./azure-url";

const AZURE_API_VERSION = "7.1";

export { adoOrgFromUrl, authHeader };
const FETCH_TIMEOUT_MS = 20_000;

export type { AzureConnection };

/** Seal a PAT for storage. Kept here so callers never import encryption directly. */
export function sealPat(token: string): string {
  return encrypt(token);
}

/**
 * The panel organization's connection for one Azure DevOps organization.
 * Cross-tenant lookups are impossible: the panel org comes from the request
 * context, never from client input.
 */
export async function getConnection(
  organizationId: string,
  adoOrg: string,
): Promise<AzureConnection | undefined> {
  return repos.azureConnection.findByAdoOrg(organizationId, adoOrg);
}

/** Decrypted PAT for a connection. Returns null when the envelope is corrupt. */
export function connectionToken(connection: AzureConnection): string | null {
  try {
    return decrypt(connection.patEncrypted);
  } catch {
    return null;
  }
}

/**
 * Resolve the credential for an Azure DevOps REST call whose URL already
 * names the organization. The panel org always comes from the execution
 * context, so a caller cannot reach another tenant's connection by shaping
 * the URL.
 */
export async function getCredential(ctx: RequestContext, url: string): Promise<string> {
  const adoOrg = adoOrgFromUrl(url);
  if (!adoOrg) {
    throw new AppError("Azure DevOps URL does not name an organization", 400);
  }
  const organizationId = ctx.organizationId;
  if (!organizationId) {
    throw new AppError("Azure DevOps is not connected for this organization", 400);
  }
  const connection = await getConnection(organizationId, adoOrg);
  if (!connection || connection.status === "invalid") {
    throw new AppError(
      `Azure DevOps organization "${adoOrg}" is not connected. Connect it in Settings → Git.`,
      400,
    );
  }
  const token = connectionToken(connection);
  if (!token) {
    throw new AppError(
      `The stored Azure DevOps credential for "${adoOrg}" could not be decrypted. Reconnect the organization.`,
      500,
    );
  }
  return token;
}

export async function azureRequest<T>(
  url: string,
  token: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("api-version")) {
    parsed.searchParams.set("api-version", AZURE_API_VERSION);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      method: init?.method ?? "GET",
      headers: {
        Authorization: authHeader(token),
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    // Azure DevOps returns 203 + a sign-in HTML page for a rejected PAT instead of 401.
    if (res.status === 203) {
      throw new AppError("Azure DevOps rejected this credential (203)", 401);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AppError(
        `Azure DevOps API error (${res.status}): ${text.slice(0, 300)}`,
        res.status >= 500 ? 502 : 400,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function azureFetch<T>(
  url: string,
  ctx: RequestContext,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const token = await getCredential(ctx, url);
  return azureRequest<T>(url, token, init);
}

export async function azureFetchText(url: string, ctx: RequestContext): Promise<string | undefined> {
  const token = await getCredential(ctx, url);

  const parsed = new URL(url);
  if (!parsed.searchParams.has("api-version")) {
    parsed.searchParams.set("api-version", AZURE_API_VERSION);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      headers: { Authorization: authHeader(token), Accept: "text/plain" },
      signal: controller.signal,
    });
    if (res.status === 203 || !res.ok) return undefined;
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clone credential for a project's deploy pipeline: the project's own token
 * override (upstream `cloneTokenEncrypted` column) wins, then the owning
 * panel organization's connection for the project's Azure DevOps org.
 */
export async function cloneCredential(opts: {
  projectId: string;
  ctx: RequestContext;
}): Promise<string | null> {
  const project = await repos.project.findById(opts.projectId);
  if (!project) return null;
  if (project.cloneTokenEncrypted) {
    try {
      return decrypt(project.cloneTokenEncrypted);
    } catch {
      /* fall through to the organization connection */
    }
  }
  const { organizationId, gitOwner } = project;
  if (!organizationId || !gitOwner) return null;
  const connection = await getConnection(organizationId, gitOwner);
  if (!connection) return null;
  return connectionToken(connection);
}

