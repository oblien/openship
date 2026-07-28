/**
 * @module clone-auth
 *
 * Thin adapter over the unified token dispatcher in `github.token.ts` for
 * the deploy pipeline. The dispatcher (`tokenFor(userId, purpose, ctx)`)
 * already encodes the full priority chain; this file only translates the
 * deploy-specific `buildStrategy` discriminator into a `purpose`:
 *
 *   - buildStrategy="local"  → tokenFor(..., "local")
 *   - buildStrategy="server" → requireTokenFor(..., "remote")
 *
 * gh CLI tokens are never returned for "remote" — that policy lives in
 * `tokenFor("remote", ...)` and the rejection happens before this
 * function ever sees a token.
 *
 * Token priority (single source of truth — see github.token.ts):
 *   - purpose: "local"  → gh CLI > App > project > user-pat > OAuth
 *     (auto-resolved credentials first; gh is opt-in-gated for multi-user)
 *   - purpose: "remote" → project > user-pat > App > REFUSE (no gh CLI)
 *
 * This function owns the ORDER of the whole clone-credential chain; the steps
 * that aren't tokens live beside it here rather than in their own resolvers, so
 * there is one readable sequence. The order is the OPERATOR's precedence — the
 * self-hosted model has no GitHub App, so the operator's own switches come first:
 *
 *   1. FORWARD my git identity — the operator flipped "Forward my git identity to
 *      build servers" (Settings → Clone credentials) and a local `gh` exists:
 *      clone directly on the build host over the desktop relay, nothing persisted.
 *   2. the server's OWN pre-existing git access (ambient `gh`/helper/ssh, verified
 *      per repo; `anonymous` when the repo needs no credential at all).
 *   3. per-server stored identity (Server tab: device token / PAT / ssh key).
 *   4. App installation or PAT (`tokenFor("remote")`) — cloud mode; self-host has none.
 *   5. public repo → anonymous (fast-path API check; the step-2 probe is the authority).
 *   6. api-host clone + context transfer (docker only) — clone here, ship the source.
 *
 * Each step self-gates on its own inputs (a per-server cred needs a serverId, the
 * ambient probe needs a server executor, the relay needs desktop + the setting +
 * an SSH tunnel), so a step only fires when it CAN — precedence decides only when
 * several are available at once.
 */

import { type BuildStrategy } from "@repo/core";
import type { AmbientGitVia, CommandExecutor } from "@repo/adapters";
import { tokenFor, requireTokenFor, type TokenContext } from "./github.token";
import { isPublicRepo } from "./github.http";
import { getLocalGhToken, hasLocalGitIdentity } from "./github.local-auth";
import { resolveServerGitCredential } from "./server-github.service";
import type { RequestContext } from "../../lib/request-context";

/**
 * Result of build-token resolution:
 *   - `{ token }`        → inject into the clone URL (existing behavior).
 *   - `{ relay: true }`  → no token, but the target server opted into git
 *     credential forwarding: clone via the desktop relay (gh identity, never
 *     persisted on the remote). The orchestrator opens the relay.
 *   - `{}`               → no credential (a local build of a public repo).
 */
export interface BuildGitCredential {
  token?: string;
  relay?: boolean;
  /**
   * The TARGET SERVER authenticates the clone with its own pre-existing git
   * credentials, verified against this repo by `probeServerGitAccess`. Nothing is
   * shipped to it and nothing is read off it. Valid only for a clone that runs on
   * that server.
   */
  ambient?: { via: AmbientGitVia };
  /**
   * Public repo on a remote clone: no credential is needed at all, so an
   * on-server clone (or anonymous tarball download) can proceed. Distinct from
   * `{}` — which also means "local build, nothing resolved" — because the
   * pipeline must be able to tell "nothing needed" from "nothing available".
   */
  anonymous?: boolean;
  /**
   * Set when a server clone-on-server was requested but no SHIPPABLE credential
   * (relay / App / PAT) exists, so the caller must degrade to an api-host clone
   * (clone on the orchestrator, transfer the context). Any `token` returned
   * alongside this is a LOCAL credential valid ONLY for cloning on this host — it
   * must NOT be shipped off-host. Callers therefore treat token-presence as
   * "shippable" only when this flag is absent.
   */
  apiHostFallback?: boolean;
  /**
   * SSH credential for cloning over git@github.com. Returned by a per-server
   * config whose mode is ssh-server-key / ssh-deploy-key. Can't be a `token`
   * (HTTPS-only), so it's carried here and consumed by the adapter clone step
   * (GIT_SSH_COMMAND with a 0600 key + pinned known_hosts). Decrypted only at
   * deploy time; never logged.
   */
  ssh?: {
    keyKind: "server-key" | "deploy-key";
    /** Decrypted OpenSSH private key. */
    privateKey: string;
    /** Pinned github.com host keys for StrictHostKeyChecking. */
    knownHosts: string;
  };
}

/** Resolve a credential for a clone that runs on THIS host (local gh, else the
 *  resolver chain). Shared by the local-build path and the api-host fallback. */
async function resolveLocalCredential(
  ctx: RequestContext,
  tokenCtx: TokenContext,
): Promise<{ token?: string }> {
  const ghToken = await getLocalGhToken();
  if (ghToken) return { token: ghToken };
  const r = await tokenFor(ctx, "local", tokenCtx);
  return r?.token ? { token: r.token } : {};
}

export async function resolveBuildGitToken(opts: {
  /** Caller's request context. Carries userId + organizationId; org-scoped
   *  App installation lookup uses ctx.organizationId. */
  ctx: RequestContext;
  projectId: string;
  owner?: string | null;
  /** Repo name — threaded to the github-access gate for PER-REPO
   *  authorization (so a member granted only repo X can build X). */
  repo?: string | null;
  buildStrategy: BuildStrategy;
  /**
   * Target server id (server deploys). When set, a per-server GitHub auth
   * config wins for clones that run on THAT server (self-hosted only). Left
   * unset for local/cloud clones.
   */
  serverId?: string | null;
  /**
   * Desktop-only: when a SERVER build has no remote token (no App / PAT),
   * signal `{ relay: true }` instead of throwing — set by the orchestrator only
   * when the operator opted in for THIS deploy (the deploy flow's "Forward my
   * git credentials" choice → `snapshot.forwardGitCredentials`) and it's an
   * eligible (non-docker) server build. The gh token is NOT returned here; it's
   * fetched on demand by the relay's remote helper, so it never lands on the
   * build host.
   */
  allowRelayFallback?: boolean;
  /**
   * DOCKER clone-on-server only: when a SERVER clone has no shippable credential
   * (no relay, no App/PAT), degrade to an api-host clone instead of throwing —
   * return `{ apiHostFallback: true }` (with a LOCAL token when one exists). The
   * pipeline then clones on the orchestrator and transfers the context. Bare
   * server builds must NOT set this (they can only clone on the target and are
   * gated by their own hard-fail preflight checks).
   */
  allowApiHostFallback?: boolean;
  /**
   * Executor for the TARGET SERVER, when the clone will run there. Enables the
   * ambient probe ("can this server reach the repo with its own credentials?").
   * Omit for local/cloud clones — there is no server identity to consult.
   */
  serverExecutor?: Pick<CommandExecutor, "exec"> | null;
  /** Clone URL, required by the ambient probe (it verifies this exact remote). */
  repoUrl?: string | null;
  /** Build-log sink for the probe's one-line outcome. Never receives secrets. */
  onLog?: (message: string) => void;
}): Promise<BuildGitCredential> {
  const tokenCtx: TokenContext = {
    projectId: opts.projectId,
    owner: opts.owner ?? undefined,
    repo: opts.repo ?? undefined,
  };

  if (opts.buildStrategy === "local") {
    // LOCAL build: clone + build run on THIS host, the token never leaves it,
    // and we're already authenticated via gh — so use the local gh token
    // DIRECTLY, no SaaS App-token fetch. (Same rule as local READS in
    // githubFetch: local op → gh.) Falls through to the full resolver chain
    // (App installation / project PAT / user PAT / OAuth) only when there's no
    // local gh. getLocalGhToken self-guards to null in CLOUD_MODE.
    return resolveLocalCredential(opts.ctx, tokenCtx);
  }

  // ── SERVER / REMOTE build: the clone/build runs off this host. ──────────────
  // Order = the operator's precedence (see the module doc). Each block self-gates
  // on its own inputs, so precedence only decides between the ones that CAN fire.

  // 1. FORWARD (operator setting). `allowRelayFallback` is set by the pipeline
  //    ONLY when the "Forward my git identity to build servers" setting is on AND
  //    this is an eligible build (desktop, non-docker, an SSH reverse tunnel).
  //    This is the operator's explicit "always use this" switch, so it wins
  //    first. The relay vends the operator's LOCAL gh on demand — never persisted
  //    on the remote — so only forward when a gh identity actually exists;
  //    otherwise fall through so the relay never opens to vend nothing.
  if (opts.allowRelayFallback && (await hasLocalGitIdentity())) {
    return { relay: true };
  }

  // 2. The SERVER's OWN git (`gh` logged in there, a credential helper, its own
  //    ssh key), verified against THIS repo so a server authenticated as the
  //    wrong account reports nothing instead of failing mid-build. No credential
  //    moves in either direction. `"anonymous"` = the repo needs none at all
  //    (public) — the authoritative public check, since it actually attempts the
  //    clone from the machine that will do it, unlike the rate-limited API probe.
  if (opts.serverExecutor && opts.repoUrl) {
    const { probeServerGitAccess } = await import("./server-git-ambient");
    const probed = await probeServerGitAccess({
      executor: opts.serverExecutor,
      repoUrl: opts.repoUrl,
      onLog: opts.onLog,
    });
    if (probed?.via === "anonymous") return { anonymous: true };
    if (probed) return { ambient: { via: probed.via } };
  }

  // 3. Per-server stored identity (Server tab: device-flow token, per-server PAT,
  //    or an SSH key). The operator explicitly configured this host, so it wins
  //    over the shared App/PAT chain for clones that run on it.
  if (opts.serverId) {
    const serverCred = await resolveServerGitCredential({
      serverId: opts.serverId,
      ctx: opts.ctx,
      owner: opts.owner ?? null,
      repo: opts.repo ?? null,
    });
    if (serverCred) return serverCred;
  }

  // 4. SaaS-minted App installation token (short-lived, repo-scoped) or a PAT —
  //    gh is REFUSED in this chain (HIGH #7: never ship the operator's broad
  //    token off-host via the URL). This is the only shippable credential in
  //    cloud mode, where none of steps 1-3 apply.
  const r = await tokenFor(opts.ctx, "remote", tokenCtx);
  if (r?.token) return { token: r.token };

  // 5. PUBLIC github.com repo → clone anonymously (nothing to ship). FAST PATH
  //    ONLY: isPublicRepo is unauthenticated + rate-limited (60/hr/IP) and fails
  //    closed, so a "no" here means "not proven public", NEVER "private" — step 2
  //    is the real authority when a server executor exists. Kept for cloud clones
  //    (no executor to probe with) and as a cheap early out.
  if (opts.owner && opts.repo && (await isPublicRepo(opts.owner, opts.repo))) {
    return { anonymous: true };
  }

  // 6. Docker clone-on-server with nothing shippable: degrade to an api-host
  //    clone (clone on THIS host, transfer the context) rather than hard-failing
  //    after the server was already provisioned. The clone runs on THIS host, so
  //    a LOCAL credential is valid (flagged apiHostFallback so callers never ship
  //    it off-host).
  if (opts.allowApiHostFallback) {
    const local = await resolveLocalCredential(opts.ctx, tokenCtx);
    return { ...local, apiHostFallback: true };
  }

  // Otherwise surface the standard actionable error (requireTokenFor throws).
  await requireTokenFor(opts.ctx, "remote", tokenCtx);
  // Unreachable: requireTokenFor always throws when no token is resolvable.
  return {};
}
