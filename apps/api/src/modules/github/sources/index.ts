/**
 * GitHub source resolver — THE single place source selection happens.
 *
 * createGitHubSource(ctx) replaces the scattered
 * resolveGitHubAuthMode → getUserStatus → resolveListingSource → tokenFor
 * re-derivation. Callers (the controllers) just hand off to the resolved source.
 *
 *   - CLOUD_MODE (the SaaS): GitHubAppSource directly — App service ONLY, no
 *     gh, no merge. CLOUD_MODE needs NO cloud probe (the mode is "app").
 *   - local: LocalGitHubSource (the merge). gh-FIRST — built from a LOCAL gh
 *     token read with NO cloud round-trip. The App sub-source (and the cloud
 *     mode-probe it needs) is resolved LAZILY inside the merge, only when a
 *     clone token / connection-status is requested. So a plain library listing
 *     stays 100% local — zero cloud.
 *
 * gh-cli-source / local-source / app-source are loaded via `await import` so
 * the gh code path never enters the SaaS process.
 */

import { env } from "../../../config/env";
import type { RequestContext } from "../../../lib/request-context";
import type { GitHubSource } from "./types";

export async function createGitHubSource(ctx: RequestContext): Promise<GitHubSource> {
  // SaaS: the App service only. Zero gh, no merge, no cloud mode-probe.
  if (env.CLOUD_MODE) {
    const { GitHubAppSource } = await import("./app-source");
    return new GitHubAppSource(ctx, "app");
  }

  // Local: gh-FIRST. Resolve the gh sub-source from a LOCAL token read — do NOT
  // probe the cloud here. A user who disconnected local GitHub auth must not
  // have the instance-wide credential silently reintroduced for discovery.
  const { isGithubCliDisabled } = await import("../../settings/settings.service");
  const cliDisabled = await isGithubCliDisabled(ctx.userId).catch(() => true);
  const { GhCliSource } = await import("./gh-cli-source");
  const gh = new GhCliSource(ctx.userId);
  const { LocalGitHubSource } = await import("./local-source");
  return new LocalGitHubSource(ctx, !cliDisabled && (await gh.token()) ? gh : null);
}
