import { z } from "zod";
import { AppError } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import type { ActionOperations, ActionRepositoryChecks } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { createGitHubSource } from "../github/sources/index";
import { getInstallationToken, githubFetch } from "../github/github.auth";
import { GitHubApiError } from "../github/github.error";
import { filterAllowedAccounts } from "../github/github-access";
import { authorizeActionRepository } from "./access";

/** A read-only setup check, scoped to the same repository and credentials as
 * execution/reporting. Never create a Check, registration or workflow run here. */
export async function actionRepositoryChecks(
  ctx: ExecutionContext,
  input: Parameters<ActionOperations["repositoryChecks"]>[0],
): Promise<ActionRepositoryChecks> {
  const { owner, repo, controller } = input;
  const repository = `${owner}/${repo}`;
  const connection = await (await createGitHubSource(ctx)).getConnectionStatus();
  const { state } = connection;
  const accounts = await filterAllowedAccounts(
    ctx,
    connection.accounts,
    (account) => account.login,
  );
  const primary =
    state.primary === "personal-token"
      ? state.sources.personalToken
      : state.primary === "gh-cli"
        ? state.sources.ghCli
        : state.sources.openshipApp;
  const installation = accounts.find(
    (account) => account.login.toLowerCase() === owner.toLowerCase() && account.source === "app",
  );
  let account: ActionRepositoryChecks["account"] = primary?.login
    ? { login: primary.login, avatarUrl: primary.avatarUrl ?? "", kind: "account" }
    : installation
      ? { login: installation.login, avatarUrl: installation.avatar_url, kind: "installation" }
      : null;
  const result = (status: ActionRepositoryChecks["status"]): ActionRepositoryChecks => ({
    repository,
    account,
    status,
  });
  try {
    await authorizeActionRepository(ctx, owner, repo);
    if (controller === "openship") {
      // A login or installation on another repository cannot prove Checks write
      // access. The existing mint verifies the exact repository and permissions.
      const token = await getInstallationToken(ctx, owner, undefined, {
        repositories: [repo],
        permissions: { checks: "write" },
      });
      if (!token) return result("app_required");
      account = {
        login: installation?.login ?? owner,
        avatarUrl: installation?.avatar_url ?? "",
        kind: "installation",
      };
      return result("connected");
    }
    if (!state.primary && !installation) return result("not_connected");
    const root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    // The write authority prevents public/anonymous fallback. GitHub owns these
    // Checks, so a separate App with Checks write is not required. Verify its
    // Actions/runner-management reads, not merely a login or public repo lookup.
    const [permissions, runners] = await Promise.all([
      githubFetch<unknown>({
        ctx,
        owner,
        repo,
        url: `${root}/actions/permissions`,
        authorizeAs: "write",
      }),
      githubFetch<unknown>({
        ctx,
        owner,
        repo,
        url: `${root}/actions/runners`,
        params: { per_page: 1 },
        authorizeAs: "write",
      }),
    ]);
    const parsed = z.object({ enabled: z.boolean() }).safeParse(permissions);
    const listed = z
      .object({
        total_count: z.number().int().nonnegative(),
        runners: z.array(z.object({ id: z.number().int().positive(), name: z.string() })),
      })
      .safeParse(runners);
    if (!parsed.success || !listed.success)
      throw new Error("GitHub did not confirm this repository's Actions settings");
    return result(parsed.data.enabled ? "connected" : "actions_disabled");
  } catch (error) {
    diagnostics.warn(
      "actions/repository-checks",
      "Could not verify repository Checks access",
      error,
    );
    if (
      (error instanceof GitHubApiError &&
        (error.credentialRejected || [404, 422].includes(error.status))) ||
      (error instanceof AppError && [401, 403, 404].includes(error.statusCode))
    )
      return result("access_required");
    return result("unavailable");
  }
}
