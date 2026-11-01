/**
 * GitHub source resolver — THE single place source selection happens.
 *
 * createGitHubSource(ctx) replaces the scattered
 * resolveGitHubAuthMode → getUserStatus → resolveListingSource → tokenFor
 * re-derivation. Callers (the controllers) just hand off to the resolved source.
 *
 *   - CLOUD_MODE (the SaaS): GitHubAppSource — no host identity or cloud probe.
 *   - local: LocalGitHubSource (the merge). gh-FIRST — built from a LOCAL gh
 *     token read with NO cloud round-trip. The App sub-source (and the cloud
 *     mode-probe it needs) is resolved LAZILY inside the merge, only when a
 *     clone token / connection-status is requested. So a plain library listing
 *     stays 100% local — zero cloud.
 *   - An enabled user PAT supplements either source through the same token
 *     resolver used by API reads and clones.
 *
 * gh-cli-source / local-source / app-source are loaded via `await import` so
 * the gh code path never enters the SaaS process.
 */

import { env } from "@repo/platform/engine/config/env";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import type { GitHubSource } from "@repo/platform/engine/modules/github/sources/types";
import { mayUseInstanceGitIdentity } from "../github-instance-access";
import { tokenFor } from "../github.token";

async function withPersonalToken(ctx: RequestContext, source: GitHubSource): Promise<GitHubSource> {
  const credential = await tokenFor(ctx, "local", { only: ["user-pat"] });
  if (!credential) return source;
  const { PersonalTokenGitHubSource } = await import("./personal-token-source");
  return new PersonalTokenGitHubSource(ctx, source, credential.token);
}

export async function createGitHubSource(ctx: RequestContext): Promise<GitHubSource> {
  // SaaS: user credentials only. No host identity or cloud mode-probe.
  if (env.CLOUD_MODE) {
    const { GitHubAppSource } = await import("@repo/platform/engine/modules/github/sources/app-source");
    return withPersonalToken(ctx, new GitHubAppSource(ctx, "app"));
  }

  // Local: gh-FIRST. Resolve the gh sub-source from a LOCAL token read — do NOT
  // probe the cloud here. The merge resolves the App side lazily.
  const { GhCliSource } = await import("@repo/platform/engine/modules/github/sources/gh-cli-source");
  const gh = new GhCliSource(ctx.userId);
  const { LocalGitHubSource } = await import("@repo/platform/engine/modules/github/sources/local-source");
  return withPersonalToken(ctx, new LocalGitHubSource(ctx, (await mayUseInstanceGitIdentity(ctx)) && (await gh.token()) ? gh : null));
}
