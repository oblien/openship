import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { ExecutionContext as RequestContext } from "../../../../context";
import type { PreflightCheck } from "../../deployments/preflight";
import { relayConfigEligible } from "../../deployments/clone-plan";
import { hasLocalGitIdentity } from "../../github/github.local-auth";
import { isPublicRepo } from "../../github/github.http";
import {
  getInstallationId,
  getInstallationIdByOrg,
  getGitHubAuthMode,
  resolveGitHubAuthMode,
  resolveInstallUrl,
} from "../../github/github.auth";
import { canResolveTokenFor } from "../../github/github.token";
import { canResolveServerGitCredential } from "../../github/server-github.service";
import { parseRepoUrl } from "../../github/github.service";
import type { GitPreflight } from "../preflight-types";
import { GIT_PREFLIGHT_ERROR_CODES as PREFLIGHT_ERROR_CODES } from "../preflight-types";

/** Resolve owner/repo for the public-ness probe: prefer the already-parsed
 *  hints, else fall back to the shared GitHub URL parser. */
function parseGithubOwnerRepo(
  repoUrl?: string,
  ownerHint?: string | null,
  repoHint?: string | null,
): { owner: string; repo: string } | null {
  if (ownerHint && repoHint) return { owner: ownerHint, repo: repoHint };
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) return null;
  return { owner: ownerHint || parsed.owner, repo: parsed.repo };
}

/**
 * Check the GitHub App is installed for the project's owner. Cloud builds
 * REQUIRE an installation token (no OAuth fallback - sending a long-lived
 * user-scope token to cloud infra would be too broad). If the owner has
 * no installation row, every cloud build for this project will fail with
 * a 403 from `resolveBuildGitToken`. Catch it in preflight so the user
 * sees an actionable message + the install URL.
 */
async function checkGitHubAppInstallation(
  ctx: RequestContext | null,
  owner: string | null | undefined,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "github-app-installation",
    label: "GitHub App access",
  };
  if (!ctx) {
    return { ...baseCheck, status: "warn", message: "User session missing - skipping check." };
  }
  if (!owner) {
    return { ...baseCheck, status: "pass" };
  }
  // Per-user mode resolution — picks "cloud-app" on self-hosted +
  // cloud-connected. Both App-scoped modes need an installation on
  // the owner; cli / oauth / token modes don't (they use the user's
  // own credentials, not installation-scoped tokens).
  const mode = await resolveGitHubAuthMode(ctx);
  if (mode !== "app" && mode !== "cloud-app") {
    return { ...baseCheck, status: "pass" };
  }
  // Mirror tokenFor: prefer org-scoped installation row, fall back to
  // the per-user row.
  let installationId: number | null = null;
  if (ctx.organizationId) {
    installationId = await getInstallationIdByOrg(ctx.organizationId, owner).catch(
      (diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/preflight");
        return null;
      },
    );
  }
  if (!installationId) {
    installationId = await getInstallationId(ctx, owner).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/preflight");
      return null;
    });
  }
  if (installationId) {
    return { ...baseCheck, status: "pass" };
  }
  const install = await resolveInstallUrl(ctx);
  return {
    ...baseCheck,
    status: "fail",
    code: PREFLIGHT_ERROR_CODES.GITHUB_APP_INSTALLATION_REQUIRED,
    message:
      `The Openship GitHub App is not installed on "${owner}". ` +
      `Deploys need it to mint a scoped token for cloning the repo. ` +
      `Install it at ${install.url} and deploy again.`,
  };
}

/**
 * Warn when a deploy will ship the user's broad-scope token to a remote
 * build worker. This happens specifically when:
 *
 *   - The API runs in a non-App mode (oauth / cli / token) - no short-lived
 *     installation token exists to mint.
 *   - The build runs on the deploy target (`buildStrategy === "server"`),
 *     not on the API host - so the token has to travel.
 *   - The deploy target is remote (not the same host as the API).
 *
 * In that combination, today we ship the OAuth / gh / static PAT to the
 * remote target as `x-access-token` for clone. That token has access to
 * the user's entire GitHub footprint. A future phase will route this via
 * API-proxied clone + tarball ship so no token leaves the API process.
 * Until then, this preflight check surfaces the trade-off and recommends
 * switching to `buildStrategy=local` (which is already safe).
 */
/**
 * True when the desktop git-credential relay will clone this remote build: the
 * operator hasn't opted out of forwarding (the default), it's a desktop host,
 * and a local gh token exists for the relay's remote helper to vend. Mirrors
 * clone-auth's `{ relay: true }` path + clone-plan's `relayEligible`, so
 * preflight is never stricter than the pipeline. The gh token is fetched on
 * demand over the reverse tunnel and NEVER shipped to the build host — so this
 * does not relax the "don't ship the gh token off-host" rule.
 */
async function relayWillClone(
  isDesktop: boolean,
  forwardGitCredentials: boolean | undefined,
): Promise<boolean> {
  if (!relayConfigEligible({ isDesktop, forwardGitCredentials })) return false;
  return hasLocalGitIdentity();
}

async function checkRemoteBuildTokenLeak(
  ctx: RequestContext | null,
  effectiveTarget: string,
  buildStrategy: "local" | "server" | undefined,
  serverId: string | undefined,
  isDesktop: boolean,
  forwardGitCredentials: boolean | undefined,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "remote-build-token",
    label: "Remote build credential",
  };
  // Per-user resolution so cloud-app (self-hosted + cloud-connected)
  // gets recognised as App-scoped. Fall back to sync resolution when
  // no ctx is available (e.g. preflight invoked from a CLI tool).
  const mode = ctx ? await resolveGitHubAuthMode(ctx) : getGitHubAuthMode();
  // App-scoped modes (local-signed or cloud-proxied) already use
  // short-lived installation tokens — safe to ship to a remote build.
  if (mode === "app" || mode === "cloud-app") return { ...baseCheck, status: "pass" };
  if (buildStrategy === "local") return { ...baseCheck, status: "pass" };
  if (effectiveTarget === "cloud") return { ...baseCheck, status: "pass" };
  // A per-server credential means the clone authenticates as the SERVER, not by
  // shipping the operator's gh-cli token off-host — so the leak concern (and the
  // cli hard-fail below) doesn't apply.
  if (
    serverId &&
    (await canResolveServerGitCredential(serverId).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/preflight");
      return false;
    }))
  ) {
    return { ...baseCheck, status: "pass" };
  }

  // The desktop credential-forward relay clones on the build host over a reverse
  // SSH tunnel — the gh token is vended on demand and never shipped there, so
  // when it's the active clone path there's no leak to gate. Same path the
  // build pipeline takes (`clone-auth.ts` → `{ relay: true }`).
  if (await relayWillClone(isDesktop, forwardGitCredentials)) {
    return { ...baseCheck, status: "pass" };
  }

  // gh CLI tokens are the user's personal long-lived PAT. At deploy time the
  // resolver simply REFUSES gh for "remote" and throws the generic
  // GITHUB_REMOTE_TOKEN_REQUIRED (github.token.ts). This advisory check surfaces
  // the specific gh-cli reason earlier — GITHUB_CLI_REMOTE_BUILD_REJECTED is
  // emitted ONLY here, not by the resolver; the dashboard maps both to the
  // credential modal. (Only reached when the relay isn't the clone path — see
  // relayWillClone above.)
  if (mode === "cli") {
    return {
      ...baseCheck,
      status: "fail",
      code: PREFLIGHT_ERROR_CODES.GITHUB_CLI_REMOTE_BUILD_REJECTED,
      message:
        `gh CLI auth only works for local builds. ` +
        `Connect the Openship App in Settings → GitHub, or set a per-project ` +
        `clone token, then deploy again.`,
    };
  }

  // Other non-App modes (oauth / static token) — ship-the-token risk
  // is the user/operator's explicit choice. Warn but don't refuse.
  return {
    ...baseCheck,
    status: "warn",
    code: PREFLIGHT_ERROR_CODES.REMOTE_BUILD_TOKEN_LEAK_RISK,
    message:
      `Building on the remote target will ship your GitHub credential there. ` +
      `Switch to "Build on this machine" (buildStrategy=local) to keep the token ` +
      `on the API host, or install the GitHub App to mint short-lived per-repo tokens.`,
  };
}

/**
 * Atomic remote-clone-token check. The single source of truth for
 * "can this deploy actually clone the repo on the build worker?" — runs
 * the same `tokenFor(userId, "remote", ...)` resolver clone-auth uses at
 * deploy time, but non-throwing.
 *
 * Skipped when:
 *   - no userId / no owner (nothing to resolve)
 *   - buildStrategy === "local" (clone happens on the API host, not remote)
 *   - effectiveTarget === "local" (no remote at all)
 *
 * On fail, emits GITHUB_REMOTE_TOKEN_REQUIRED — the dashboard maps that
 * code to DeployCredentialModal (install App / add PAT /
 * build locally). This subsumes the per-mode App-installation check
 * for the remote-clone case but we keep `checkGitHubAppInstallation`
 * for clearer error copy when the App is configured but uninstalled.
 */
async function checkRemoteCloneToken(
  ctx: RequestContext | null,
  owner: string | null | undefined,
  projectId: string | undefined,
  effectiveTarget: string,
  buildStrategy: "local" | "server" | undefined,
  serverId: string | undefined,
  isDesktop: boolean,
  forwardGitCredentials: boolean | undefined,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "remote-clone-token",
    label: "Remote clone credential",
  };
  if (!ctx || !owner) return { ...baseCheck, status: "pass" };
  if (buildStrategy === "local") return { ...baseCheck, status: "pass" };
  if (effectiveTarget === "local") return { ...baseCheck, status: "pass" };

  // A per-server GitHub credential (device token / PAT / SSH key) satisfies the
  // clone directly — check it FIRST (matches clone-auth's precedence).
  if (
    serverId &&
    (await canResolveServerGitCredential(serverId).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/preflight");
      return false;
    }))
  ) {
    return { ...baseCheck, status: "pass" };
  }

  // Existence check only — no mint. The real mint happens later in the
  // build pipeline when we actually need to clone.
  const source = await canResolveTokenFor(ctx, "remote", {
    projectId,
    owner,
  }).catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/preflight");
    return null;
  });
  if (source) return { ...baseCheck, status: "pass" };

  // Desktop relay: clones on the build host via the reverse tunnel (nothing
  // shipped) — a valid remote-clone path canResolveTokenFor doesn't surface.
  if (await relayWillClone(isDesktop, forwardGitCredentials)) {
    return { ...baseCheck, status: "pass" };
  }

  return {
    ...baseCheck,
    status: "fail",
    code: PREFLIGHT_ERROR_CODES.GITHUB_REMOTE_TOKEN_REQUIRED,
    message:
      `No GitHub credential available to clone "${owner}" onto the build worker. ` +
      `Install the Openship App on this owner, add a per-project clone token, ` +
      `or switch to "Build on this machine" so the credential stays on the API host.`,
  };
}

/**
 * Clone-on-server credential check (DOCKER opt-in, `cloneStrategy === "server"`).
 *
 * Unlike bare (which hard-fails without a remote credential — see
 * `checkRemoteCloneToken`), docker gracefully falls back to cloning on the API
 * host + transfer when no shippable credential exists. So a missing credential
 * here is a WARN, not a failure: it tells the user the deploy will fall back.
 *
 *   - desktop → the git-credential relay (reverse tunnel; nothing persisted).
 *     Opened at deploy time; if the server's SSH auth can't host it the pipeline
 *     warns + falls back. Nothing to verify up-front — pass.
 *   - non-desktop → a short-lived token is shipped to the server. Same
 *     `tokenFor(purpose:"remote")` resolver clone-auth uses; existence-only.
 */
async function checkCloneOnServerCredential(
  ctx: RequestContext | null,
  owner: string | null | undefined,
  projectId: string | undefined,
  platformTarget: string,
  serverId: string | undefined,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "clone-on-server",
    label: "Clone-on-server credential",
  };
  if (platformTarget === "desktop") {
    // Desktop default: clone on the server via the forwarded git identity (used
    // for the build only, never stored). Opting out clones here + transfers —
    // either way this never blocks, so it's an informational pass.
    return {
      ...baseCheck,
      status: "pass",
      message:
        "Will clone on the server using your forwarded git identity (used for this build only, never stored), or clone here and transfer if you opt out.",
    };
  }
  if (!ctx || !owner) return { ...baseCheck, status: "pass" };

  // A per-server GitHub credential clones directly on the server — satisfies
  // this check outright.
  if (
    serverId &&
    (await canResolveServerGitCredential(serverId).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/preflight");
      return false;
    }))
  ) {
    return { ...baseCheck, status: "pass" };
  }

  const source = await canResolveTokenFor(ctx, "remote", {
    projectId,
    owner,
  }).catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/preflight");
    return null;
  });
  if (source) return { ...baseCheck, status: "pass" };

  return {
    ...baseCheck,
    status: "warn",
    message:
      `"Clone on the server" is selected, but Openship holds no GitHub credential for the build host. ` +
      `The deploy will check whether the server already reaches this repo with its own git credentials ` +
      `(a \`gh\` login, a credential helper, or its ssh key) and clone there if it does — otherwise it ` +
      `falls back to cloning on the API host and transferring the context. To make the on-server clone ` +
      `deterministic, connect the server under Servers → GitHub (a read-only per-repo deploy key is the ` +
      `narrowest option), install the Openship App on "${owner}", or add a per-project clone token.`,
  };
}

export const githubPreflight: GitPreflight = {
  async isPublicRepository(url, namespace, name) {
    const repo = parseGithubOwnerRepo(url, namespace, name);
    return repo ? isPublicRepo(repo.owner, repo.repo) : false;
  },
  async checks(input) {
    const checks: PreflightCheck[] = [];
    const {
      ctx,
      namespace,
      projectId,
      effectiveTarget,
      buildStrategy,
      serverId,
      platformTarget,
      forwardGitCredentials,
    } = input;
    if (input.remoteCredential && getGitHubAuthMode() === "app")
      checks.push(await checkGitHubAppInstallation(ctx, namespace));
    if (input.clonesOnRemote) {
      checks.push(
        await checkRemoteBuildTokenLeak(
          ctx,
          effectiveTarget,
          buildStrategy,
          serverId,
          platformTarget === "desktop",
          forwardGitCredentials,
        ),
      );
      checks.push(
        await checkRemoteCloneToken(
          ctx,
          namespace,
          projectId,
          effectiveTarget,
          buildStrategy,
          serverId,
          platformTarget === "desktop",
          forwardGitCredentials,
        ),
      );
    }
    if (input.dockerClonesOnTarget)
      checks.push(
        await checkCloneOnServerCredential(ctx, namespace, projectId, platformTarget, serverId),
      );
    return checks;
  },
};
