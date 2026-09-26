/**
 * Azure DevOps REST helpers — connections, repos, branches, files, Service Hooks.
 * Every call is scoped to the execution context's panel organization.
 */

import { randomBytes } from "node:crypto";
import { buildGitUrl } from "@repo/core";
import { repos } from "@repo/db";
import { encrypt } from "../../lib/encryption";
import { sharedAzureWebhookUrl } from "../../lib/public-url";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { azureFetch, azureFetchText, azureRequest, sealPat } from "./azure.auth";

const ADO = "https://dev.azure.com";
/** Azure DevOps Service Hook publisher event — not an Openship audit `eventType`. */
const AZURE_SERVICE_HOOK_PUSH_EVENT = "git.push";

interface AzureList<T> {
  value?: T[];
}

export interface AzureRepo {
  id: string;
  name: string;
  org: string;
  project: string;
  defaultBranch: string;
  remoteUrl: string;
  webUrl: string;
  isDisabled: boolean;
}

interface AzureGitRepository {
  id: string;
  name: string;
  isDisabled?: boolean;
  defaultBranch?: string;
  remoteUrl?: string;
  webUrl?: string;
  project?: { name?: string; id?: string };
}

interface AzureRef {
  name: string;
  objectId?: string;
}

interface AzureItem {
  path?: string;
  isFolder?: boolean;
  gitObjectType?: string;
}

const AZURE_ORG_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,255}$/;

/** Organization slug from a typed name or a pasted Azure DevOps URL. */
export function normalizeAzureOrganization(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let slug = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const vs = url.hostname.match(/^([^.]+)\.visualstudio\.com$/i);
      if (vs?.[1]) slug = vs[1];
      else if (url.hostname.replace(/^www\./i, "") === "dev.azure.com") {
        slug = url.pathname.split("/").filter(Boolean)[0] ?? "";
      } else {
        return null;
      }
    } catch {
      return null;
    }
  } else {
    slug = trimmed.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  }
  return AZURE_ORG_SLUG.test(slug) ? slug : null;
}

/**
 * Validate a PAT against one Azure DevOps organization before storing it.
 * Org-scoped PATs cannot call VSSPS /accounts, so probe the org's own REST
 * surface — that is what Code (Read) / Project (Read) actually grants.
 */
export async function verifyPatCanReadOrganization(token: string, org: string): Promise<void> {
  await azureRequest(
    `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects?$top=1`,
    token,
  );
}

export async function listRepos(ctx: RequestContext, org: string): Promise<AzureRepo[]> {
  const data = await azureFetch<AzureList<AzureGitRepository>>(
    `${ADO}/${encodeURIComponent(org)}/_apis/git/repositories`,
    ctx,
  );
  return (data.value ?? [])
    .filter((r) => !r.isDisabled && r.name && r.project?.name)
    .map((r) => ({
      id: r.id,
      name: r.name,
      org,
      project: r.project!.name!,
      defaultBranch: (r.defaultBranch ?? "refs/heads/main").replace(/^refs\/heads\//, ""),
      remoteUrl: r.remoteUrl || buildGitUrl("azure", org, r.name, r.project!.name!),
      webUrl: r.webUrl || `${ADO}/${org}/${r.project!.name!}/_git/${r.name}`,
      isDisabled: Boolean(r.isDisabled),
    }));
}

export async function getRepository(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
): Promise<AzureRepo> {
  const data = await azureFetch<AzureGitRepository>(
    `${ADO}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`,
    ctx,
  );
  return {
    id: data.id,
    name: data.name,
    org,
    project: data.project?.name || project,
    defaultBranch: (data.defaultBranch ?? "refs/heads/main").replace(/^refs\/heads\//, ""),
    remoteUrl: data.remoteUrl || buildGitUrl("azure", org, data.name, project),
    webUrl: data.webUrl || `${ADO}/${org}/${project}/_git/${data.name}`,
    isDisabled: Boolean(data.isDisabled),
  };
}

export async function listBranches(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
): Promise<{ name: string }[]> {
  const data = await azureFetch<AzureList<AzureRef>>(
    `${ADO}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/refs?filter=heads/`,
    ctx,
  );
  return (data.value ?? [])
    .map((r) => r.name.replace(/^refs\/heads\//, ""))
    .filter(Boolean)
    .map((name) => ({ name }));
}

export async function listItems(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
  opts?: { path?: string; branch?: string },
): Promise<AzureItem[]> {
  const url = new URL(
    `${ADO}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/items`,
  );
  url.searchParams.set("recursionLevel", opts?.path ? "OneLevel" : "Full");
  if (opts?.path) url.searchParams.set("scopePath", opts.path.startsWith("/") ? opts.path : `/${opts.path}`);
  if (opts?.branch) {
    url.searchParams.set("versionDescriptor.version", opts.branch);
    url.searchParams.set("versionDescriptor.versionType", "branch");
  }
  const data = await azureFetch<AzureList<AzureItem>>(url.toString(), ctx);
  return data.value ?? [];
}

export async function getItemContent(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
  path: string,
  branch?: string,
): Promise<string | undefined> {
  const url = new URL(
    `${ADO}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/items`,
  );
  url.searchParams.set("path", path.startsWith("/") ? path : `/${path}`);
  url.searchParams.set("includeContent", "true");
  url.searchParams.set("download", "true");
  if (branch) {
    url.searchParams.set("versionDescriptor.version", branch);
    url.searchParams.set("versionDescriptor.versionType", "branch");
  }
  return azureFetchText(url.toString(), ctx);
}

/**
 * Register a push Service Hook on one repo, delivered with Basic auth using a
 * per-project secret. Azure DevOps signs nothing, so this secret IS the
 * verification — it must never be shared between projects.
 */
export async function registerServiceHook(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
  secret: string,
): Promise<{ subscriptionId: string; encryptedSecret: string }> {
  const repository = await getRepository(ctx, org, project, repo);
  const body = {
    publisherId: "tfs",
    eventType: AZURE_SERVICE_HOOK_PUSH_EVENT,
    resourceVersion: "1.0",
    consumerId: "webHooks",
    consumerActionId: "httpRequest",
    publisherInputs: {
      projectId: undefined as string | undefined,
      repository: repository.id,
    },
    consumerInputs: {
      url: sharedAzureWebhookUrl(),
      basicAuthUsername: "openship",
      basicAuthPassword: secret,
    },
  };
  const created = await azureFetch<{ id: string }>(
    `${ADO}/${encodeURIComponent(org)}/_apis/hooks/subscriptions`,
    ctx,
    { method: "POST", body },
  );
  if (!created.id) throw new Error("Azure DevOps did not return a Service Hook id");
  return { subscriptionId: created.id, encryptedSecret: encrypt(secret) };
}

/**
 * Enable auto-deploy for a project: register the Service Hook and persist the
 * subscription id + secret on the project row. The credential resolves through
 * the project's owning organization — callers never pass a tenant id in.
 */
export async function enableProjectHook(ctx: RequestContext, projectId: string): Promise<string> {
  const project = await repos.project.findById(projectId);
  const org = project?.gitOwner;
  const adoProject = project?.gitProject;
  const repo = project?.gitRepo;
  if (!project || !org || !adoProject || !repo) {
    throw new Error("Project has no Azure DevOps repository linked");
  }
  const secret = randomBytes(32).toString("hex");
  const { subscriptionId, encryptedSecret } = await registerServiceHook(
    ctx,
    org,
    adoProject,
    repo,
    secret,
  );
  await repos.project.update(projectId, {
    autoDeploy: true,
    webhookExternalId: subscriptionId,
    webhookSecret: encryptedSecret,
  });
  return subscriptionId;
}

/** Disable auto-deploy: remove the Service Hook and clear the project's linkage. */
export async function disableProjectHook(ctx: RequestContext, projectId: string): Promise<void> {
  const project = await repos.project.findById(projectId);
  const org = project?.gitOwner;
  if (project?.webhookExternalId && org) {
    await deleteServiceHook(ctx, org, project.webhookExternalId).catch(() => {});
  }
  await repos.project.update(projectId, {
    autoDeploy: false,
    webhookExternalId: null,
    webhookSecret: null,
  });
}

export async function deleteServiceHook(
  ctx: RequestContext,
  org: string,
  subscriptionId: string,
): Promise<void> {
  await azureFetch(
    `${ADO}/${encodeURIComponent(org)}/_apis/hooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
    ctx,
    { method: "DELETE" },
  );
}

/** Persist a verified PAT as the panel organization's connection for `org`. */
export async function saveConnection(ctx: RequestContext, org: string, token: string): Promise<void> {
  const sealed = sealPat(token);
  await repos.azureConnection.upsert({
    organizationId: ctx.organizationId,
    adoOrg: org,
    patEncrypted: sealed,
  });
}

export async function deleteConnection(ctx: RequestContext, org: string): Promise<boolean> {
  return repos.azureConnection.delete(ctx.organizationId, org);
}
