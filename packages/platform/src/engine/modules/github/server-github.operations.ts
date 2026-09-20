import { AppError, NotFoundError, safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import type { ServerDependencies } from "../../../servers";
import type { ExecutionContext } from "../../../context";
import { assertSelfHosted } from "../system/server-access";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
type GitHubService = typeof import("./server-github.service");

async function run<T>(ctx: ExecutionContext, id: string, work: (service: GitHubService) => Promise<T> | T, event?: string) {
  assertSelfHosted();
  if (!(await repos.server.getInOrganization(id, ctx.organizationId))) throw new NotFoundError("Server", id);
  try {
    // Server inspection/teardown must not initialize the unrelated OAuth graph.
    const data = await work(await import("./server-github.service"));
    if (event) audit.recordAsync(operationAuditContext(ctx), { eventType: event, resourceType: "server", resourceId: id });
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(safeErrorMessage(error), 400, "GITHUB_OPERATION_FAILED");
  }
}
export const serverGitHubResources = {
  githubStatus: (ctx, id) => run(ctx, id, service => service.getServerGithubStatus(id)),
  connectGitHub: (ctx, id) => run(ctx, id, async service => {
    const verification = await service.startServerConnect(ctx, id);
    return { userCode: verification.user_code, verificationUri: verification.verification_uri, expiresIn: verification.expires_in, interval: verification.interval };
  }, "server.github.connect"),
  pollGitHubConnection: (ctx, id) => run(ctx, id, service => service.pollServerConnect(id)),
  setGitHubToken: (ctx, id, input) => run(ctx, id, service => service.setServerToken(ctx, id, input.token), "server.github.token_set"),
  generateGitHubKey: (ctx, id) => run(ctx, id, service => service.ensureServerKey(ctx, id), "server.github.key_generated"),
  useGitHubDeployKeys: (ctx, id) => run(ctx, id, async service => { await service.setDeployKeyMode(ctx, id); return { ok: true }; }, "server.github.deploy_keys_enabled"),
  disconnectGitHub: (ctx, id) => run(ctx, id, async service => { await service.disconnectServerGithub(ctx, id); return { ok: true }; }, "server.github.disconnected"),
} satisfies Pick<ServerDependencies["resources"], "githubStatus" | "connectGitHub" | "pollGitHubConnection" | "setGitHubToken" | "generateGitHubKey" | "useGitHubDeployKeys" | "disconnectGitHub">;
