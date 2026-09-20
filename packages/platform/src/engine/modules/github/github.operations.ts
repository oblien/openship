import type { GitHubDependencies } from "../../../github";
import type { ExecutionContext } from "../../../context";
import { AppError, NotFoundError } from "@repo/core";
import { GitHubCollectionSchemas, type GitHubOperations } from "@repo/contracts";
import { authorization } from "../../lib/authorization";
import { instanceAuthorization } from "../../lib/instance-authorization";
import { env } from "../../config/env";
import { canUseGitHubRepo } from "./github-access";
import * as application from "./github-application.service";
import * as sources from "./github-source-application.service";
import { audit, operationAuditContext } from "../../lib/audit-emitter";

function localOnly() {
  if (env.CLOUD_MODE) throw new AppError("Not available on Openship Cloud", 400, "NOT_SUPPORTED");
}
function ownerOnly(ctx: ExecutionContext) {
  localOnly();
  if (ctx.role !== "owner" || ctx.tokenScope) throw new AppError("An organization owner is required", 403, "ORG_OWNER_REQUIRED");
}
const sourceMethods = new Set(["listSources", "beginManifest", "convertManifest", "createManualSource", "claimInstallation"]);
const instanceMethods = new Set(["getLocalStatus", "pollConnect", "setInstanceToken"]);
const repoReads = new Set(["getRepo", "listBranches", "getCloneToken", "detectStack", "listFiles", "listTree", "getFile", "listWebhooks", "listOrgRepos"]);

async function authorize(ctx: ExecutionContext, name: keyof typeof GitHubCollectionSchemas, input: unknown) {
  const spec = GitHubCollectionSchemas[name];
  if (sourceMethods.has(name)) return ownerOnly(ctx);
  if (instanceMethods.has(name)) {
    localOnly();
    await instanceAuthorization.assert(ctx, spec.action === "read" ? "read" : "write");
    return;
  }
  if (repoReads.has(name)) {
    const target = input as { owner?: string; org?: string; repo?: string };
    const owner = target.owner ?? target.org!;
    if (!(await canUseGitHubRepo(ctx, { owner, repo: target.repo }, "read")))
      throw new NotFoundError("github", target.repo ? `${owner}/${target.repo}` : owner);
  } else {
    await authorization.authorize(ctx, { resourceType: "github", resourceId: "*", action: spec.action, ...(name === "listRepos" && { scope: "list" as const }) });
  }
}
const collectionServices = { ...application, ...sources };
const collection = Object.fromEntries(Object.keys(GitHubCollectionSchemas).map(name => [name, async (ctx: ExecutionContext, input: unknown) => {
  await authorize(ctx, name as keyof typeof GitHubCollectionSchemas, input);
  const service = collectionServices[name as keyof typeof GitHubCollectionSchemas] as (context: ExecutionContext, value: unknown) => Promise<unknown>;
  const result = await service(ctx, input);
  if (name === "connect" || name === "claimInstallation") audit.recordAsync(operationAuditContext(ctx), {
    eventType: name === "connect" ? "github.connect" : "github.installation.claim",
    resourceType: "github", resourceId: "*",
    // Connection URLs and credentials are deliberately absent from audit data.
  });
  return result;
}])) as GitHubDependencies["collection"];
const sourceResource = <K extends keyof GitHubDependencies["resources"]>(name: K): GitHubDependencies["resources"][K] =>
  (async (ctx: ExecutionContext, id: string, input: unknown) => {
    ownerOnly(ctx);
    const service = sources[name] as (context: ExecutionContext, id: string, value: unknown) => Promise<unknown>;
    return service(ctx, id, input);
  }) as GitHubDependencies["resources"][K];
export const githubDependencies: GitHubDependencies = {
  collection,
  resources: {
    updateSource: sourceResource("updateSource"), verifySource: sourceResource("verifySource"),
    setDefaultSource: sourceResource("setDefaultSource"), createInstallUrl: sourceResource("createInstallUrl"), deleteSource: sourceResource("deleteSource"),
  },
};
