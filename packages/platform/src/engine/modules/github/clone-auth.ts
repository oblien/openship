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

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { AppError, safeErrorMessage, type BuildStrategy } from "@repo/core";
import type { AmbientGitVia, CommandExecutor } from "@repo/adapters";
import {
  tokenFor,
  requireTokenFor,
  canResolveTokenFor,
  type GitHubTokenSource,
  type TokenContext,
  type TokenResult,
} from "./github.token";
import { isPublicRepo, probeAnonymousRepoVisibility } from "./github.http";
import {
  gitmodulesTextFromContentsBody,
  MAX_SUBMODULE_REPOS,
  parseSameOwnerSubmoduleRepos,
} from "./gitmodules";
import { getLocalGhToken, hasLocalGitIdentity } from "./github.local-auth";
import { resolveServerGitCredential } from "./server-github.service";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { resolveGitHubApiBaseUrl } from "./github-source.service";

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
  /** Ephemeral exact repository grant returned by the App credential resolver. */
  tokenRepositories?: string[];
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

// ─── Credential tracing + submodule token expansion (#979) ─────────

/**
 * Which credential the clone ended up with. Logged once per resolution (never
 * the token itself) so a failed clone can be traced to the step that chose it.
 */
interface CredentialTrace {
  source: string;
  /** Repos the token is scoped to: a count for App tokens, "all" for user
   *  tokens (PAT / OAuth / gh), 0 when there is no token. */
  repos: number | "all";
  notes: string[];
}

const SOURCE_LABEL: Record<GitHubTokenSource, string> = {
  "app-installation": "app-installation",
  "user-oauth": "user-oauth",
  project: "pat-project",
  "user-pat": "pat-user",
  "gh-cli": "gh-cli",
  "server-token": "server-token",
};

interface ResolveExtras {
  /** Commit sha or branch to read `.gitmodules` at (default branch if absent). */
  gitRef?: string | null;
  onLog?: (message: string) => void;
}

function traceLog(extras: ResolveExtras, message: string, level: "info" | "warn" = "info"): void {
  if (level === "warn") {
    errorDiagnostics.warn("platform/engine/modules/github/clone-auth", `[clone-auth] ${message}`);
  } else {
    console.info(`[clone-auth] ${message}`);
  }
  try {
    extras.onLog?.(message);
  } catch {
    // The sink may include credentials or private payloads in its exception.
    observeCaughtError(
      new Error("The build log sink rejected a clone authentication diagnostic"),
      "platform/engine/modules/github/clone-auth",
    );
  }
}

function recordToken(trace: CredentialTrace, r: TokenResult, repos: number): void {
  trace.source = SOURCE_LABEL[r.source] ?? r.source ?? "token";
  trace.repos = r.source === "app-installation" ? repos : "all";
}

/**
 * Explain an App step that produced nothing. `tokenFor` returns null from the
 * App step silently in several cases (no installation row for this org+owner,
 * the github-access gate denied the actor, the auth mode is not "app", a
 * source-bound installation lost its credentials, the cloud mint came back
 * empty); only a THROWN mint is logged upstream. The probe below separates
 * "no usable installation" from "installation exists but the mint returned
 * no token" without minting.
 */
async function diagnoseEmptyAppStep(
  ctx: RequestContext,
  purpose: "local" | "remote",
  tokenCtx: TokenContext,
  extras: ResolveExtras,
  trace: CredentialTrace,
): Promise<void> {
  if (!tokenCtx.owner) return;
  const probe = await canResolveTokenFor(ctx, purpose, {
    ...tokenCtx,
    only: ["app-installation"],
  }).catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/github/clone-auth");
    return null;
  });
  const who = `owner=${tokenCtx.owner} repo=${tokenCtx.repo ?? "-"} actor=${ctx.userId ? "set" : "MISSING"}`;
  const note =
    probe === "app-installation"
      ? `App installation step returned EMPTY (${who}): an installation row exists and the actor is authorized, ` +
        `but the mint returned no token (source credentials missing, GitHub auth mode is not "app", or the cloud mint was empty)`
      : `App installation step returned EMPTY (${who}): no installation row for this owner in the org, ` +
        `or the github-access gate denied the actor`;
  trace.notes.push(note);
  traceLog(extras, note, "warn");
}

/**
 * Parent-only App tokens cannot read private submodules. Read `.gitmodules`
 * with the parent token, then remint
 * an App token covering the same-owner submodule repos. Soft: a missing file
 * keeps the parent token silently; a read error keeps it with a warning.
 */
async function expandAppTokenForSubmodules(
  ctx: RequestContext,
  purpose: "local" | "remote",
  tokenCtx: TokenContext,
  minted: TokenResult | null,
  extras: ResolveExtras,
): Promise<{ result: TokenResult | null; repos: number }> {
  const owner = tokenCtx.owner;
  const repo = tokenCtx.repo;
  if (!minted?.token || minted.source !== "app-installation" || !owner || !repo) {
    return { result: minted, repos: minted?.token ? 1 : 0 };
  }
  const parentCredential = { ...minted, repositories: [repo] };
  let extra = await fetchSameOwnerSubmoduleRepos(minted.token, owner, repo, ctx, tokenCtx, extras);
  if (extra.length > MAX_SUBMODULE_REPOS) {
    traceLog(
      extras,
      `.gitmodules lists ${extra.length} same-owner repos under ${owner}; capping token expansion at ${MAX_SUBMODULE_REPOS}`,
      "warn",
    );
    extra = extra.slice(0, MAX_SUBMODULE_REPOS);
  }
  if (!extra.length) return { result: parentCredential, repos: 1 };
  const reminted = await tokenFor(ctx, purpose, {
    ...tokenCtx,
    only: ["app-installation"],
    extraRepositories: extra,
  }).catch((err) => {
    observeCaughtError(err, "platform/engine/modules/github/clone-auth");
    return null;
  });
  if (!reminted?.token) {
    traceLog(
      extras,
      `submodule token remint for ${owner}/${repo} returned no token; keeping the parent-only token ` +
        `(private submodules may fail to clone)`,
      "warn",
    );
    return { result: parentCredential, repos: 1 };
  }
  traceLog(extras, `App token expanded for ${extra.length} same-owner submodule repo(s): ${extra.join(", ")}`);
  return { result: reminted, repos: reminted.repositories?.length ?? 1 + extra.length };
}

const GITMODULES_FETCH_TIMEOUT_MS = 10_000;

async function fetchSameOwnerSubmoduleRepos(
  token: string,
  owner: string,
  repo: string,
  ctx: RequestContext,
  tokenCtx: TokenContext,
  extras: ResolveExtras,
): Promise<string[]> {
  let apiBase = "https://api.github.com";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITMODULES_FETCH_TIMEOUT_MS);
  try {
    apiBase =
      (await resolveGitHubApiBaseUrl(ctx.organizationId, owner, tokenCtx.installationId).catch(
        () => {
          observeCaughtError(
            new Error("Could not resolve the GitHub source for submodule discovery"),
            "platform/engine/modules/github/clone-auth",
          );
          return null;
        },
      )) ?? apiBase;
    const ref = extras.gitRef ? `?ref=${encodeURIComponent(extras.gitRef)}` : "";
    // JSON contents + base64 decode: `Accept: application/vnd.github.raw` 404s
    // for App installation tokens on this endpoint (seen on 0.8.0).
    const url = `${apiBase.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.gitmodules${ref}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "openship",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    if (res.status === 404) return []; // no .gitmodules: nothing to expand
    const body = await res.text();
    if (!res.ok) {
      traceLog(
        extras,
        `reading .gitmodules for ${owner}/${repo} failed (HTTP ${res.status}); ` +
          `falling back to a parent-only token (private submodules may fail to clone)`,
        "warn",
      );
      return [];
    }
    const host = new URL(apiBase).hostname.replace(/^api\./, "");
    return parseSameOwnerSubmoduleRepos(gitmodulesTextFromContentsBody(body), owner, repo, host);
  } catch (err) {
    // diagnostics-ignore: traceLog(warn) reports this safe summary once through
    // the central diagnostics.warn; forwarding the exception would expose payloads.
    traceLog(
      extras,
      `reading .gitmodules for ${owner}/${repo} failed (${err instanceof Error ? err.name : "error"}); ` +
        `falling back to a parent-only token (private submodules may fail to clone)`,
      "warn",
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a credential for a clone that runs on THIS host (local gh, else the
 *  resolver chain). Shared by the local-build path and the api-host fallback. */
async function resolveLocalCredential(
  ctx: RequestContext,
  tokenCtx: TokenContext,
  trace: CredentialTrace = { source: "none", repos: 0, notes: [] },
  extras: ResolveExtras = {},
): Promise<BuildGitCredential> {
  const customSource = tokenCtx.owner
    ? await resolveGitHubApiBaseUrl(
        ctx.organizationId,
        tokenCtx.owner,
        tokenCtx.installationId,
      ).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/github/clone-auth"); return null; })
    : null;
  if (!customSource) {
    const ghToken = await getLocalGhToken();
    if (ghToken) {
      trace.source = "gh-cli";
      trace.repos = "all";
      return { token: ghToken };
    }
  }
  const localCtx: TokenContext = {
    ...tokenCtx,
    ...(customSource ? { only: ["app-installation"] } : {}),
  };
  const first = await tokenFor(ctx, "local", localCtx);
  if (!first?.token || (first.source !== "app-installation" && first.source !== "gh-cli")) {
    await diagnoseEmptyAppStep(ctx, "local", localCtx, extras, trace);
  }
  const { result: r, repos } = await expandAppTokenForSubmodules(ctx, "local", localCtx, first, extras);
  if (r?.token) {
    recordToken(trace, r, repos);
    return { token: r.token, ...(r.repositories ? { tokenRepositories: r.repositories } : {}) };
  }
  await assertAnonymousCloneCanWork(tokenCtx, customSource, extras, trace);
  return {};
}

/**
 * Fail LOUDLY instead of cloning a private repo anonymously. Before this, an
 * empty credential chain returned `{}` and the clone ran with no userinfo,
 * surfacing only as git's "Repository not found" with no hint that NO
 * credential was ever chosen. A definitive anonymous 404 means an anonymous
 * clone cannot succeed, so stop with the real cause. "unknown" (probe
 * throttled / offline) keeps upstream's behavior and proceeds, with a warning.
 */
async function assertAnonymousCloneCanWork(
  tokenCtx: TokenContext,
  customApiBase: string | null,
  extras: ResolveExtras,
  trace: CredentialTrace,
): Promise<void> {
  const { owner, repo } = tokenCtx;
  if (!owner || !repo) return; // not a GitHub repo (local path, other host)
  const visibility = await probeAnonymousRepoVisibility(owner, repo, customApiBase ?? undefined);
  if (visibility === "public") {
    trace.source = "none (public repo)";
    return;
  }
  if (visibility === "unknown") {
    traceLog(
      extras,
      `no GitHub credential resolved for ${owner}/${repo} and its visibility could not be confirmed; ` +
        `attempting an anonymous clone`,
      "warn",
    );
    return;
  }
  const why = trace.notes.length ? ` ${trace.notes.join("; ")}.` : "";
  throw new AppError(
    `No GitHub credential resolved for ${owner}/${repo}, and the repository is not publicly readable, ` +
      `so an anonymous clone would fail with "Repository not found".${why} ` +
      `Check the GitHub App installation for ${owner} (and that it covers ${repo}), or set a per-project clone token.`,
    403,
    "GITHUB_TOKEN_REQUIRED",
  );
}

export interface ResolveBuildGitTokenOptions {
  /** Caller's request context. Carries userId + organizationId; org-scoped
   *  App installation lookup uses ctx.organizationId. */
  ctx: RequestContext;
  projectId: string;
  owner?: string | null;
  /** Repo name — threaded to the github-access gate for PER-REPO
   *  authorization (so a member granted only repo X can build X). */
  repo?: string | null;
  /** Server-resolved project snapshot; validated against org+owner before use. */
  installationId?: number | null;
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
  /** Commit sha or branch being deployed; `.gitmodules` is read at this ref. */
  gitRef?: string | null;
}

export async function resolveBuildGitToken(opts: ResolveBuildGitTokenOptions): Promise<BuildGitCredential> {
  const trace: CredentialTrace = { source: "none", repos: 0, notes: [] };
  const extras: ResolveExtras = { gitRef: opts.gitRef, onLog: opts.onLog };
  const where = `owner=${opts.owner ?? "-"} repo=${opts.repo ?? "-"} strategy=${opts.buildStrategy}`;
  try {
    const cred = await resolveBuildGitTokenTraced(opts, trace, extras);
    const shape = cred.apiHostFallback ? " apiHostFallback=true" : "";
    traceLog(extras, `clone auth: source=${trace.source} repos=${trace.repos} ${where}${shape}`);
    return cred;
  } catch (err) {
    traceLog(
      extras,
      `clone auth: source=none (resolution failed: ${safeErrorMessage(err)}) ${where}`,
      "warn",
    );
    throw err;
  }
}

async function resolveBuildGitTokenTraced(
  opts: ResolveBuildGitTokenOptions,
  trace: CredentialTrace,
  extras: ResolveExtras,
): Promise<BuildGitCredential> {
  const tokenCtx: TokenContext = {
    projectId: opts.projectId,
    owner: opts.owner ?? undefined,
    repo: opts.repo ?? undefined,
    installationId: opts.installationId ?? undefined,
  };

  if (opts.buildStrategy === "local") {
    // LOCAL build: clone + build run on THIS host, the token never leaves it,
    // and we're already authenticated via gh — so use the local gh token
    // DIRECTLY, no SaaS App-token fetch. (Same rule as local READS in
    // githubFetch: local op → gh.) Falls through to the full resolver chain
    // (App installation / project PAT / user PAT / OAuth) only when there's no
    // local gh. getLocalGhToken self-guards to null in CLOUD_MODE.
    return resolveLocalCredential(opts.ctx, tokenCtx, trace, extras);
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
    trace.source = "relay";
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
    if (probed?.via === "anonymous") {
      trace.source = "none (public repo, server probe)";
      return { anonymous: true };
    }
    if (probed) {
      trace.source = `server-ambient:${probed.via}`;
      return { ambient: { via: probed.via } };
    }
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
    if (serverCred) {
      trace.source = serverCred.ssh ? `server-ssh:${serverCred.ssh.keyKind}` : "server-token";
      trace.repos = serverCred.token ? "all" : 0;
      return serverCred;
    }
  }

  // 4. SaaS-minted App installation token (short-lived, repo-scoped) or a PAT —
  //    gh is REFUSED in this chain (HIGH #7: never ship the operator's broad
  //    token off-host via the URL). This is the only shippable credential in
  //    cloud mode, where none of steps 1-3 apply.
  const first = await tokenFor(opts.ctx, "remote", tokenCtx);
  if (!first?.token) await diagnoseEmptyAppStep(opts.ctx, "remote", tokenCtx, extras, trace);
  const { result: r, repos } = await expandAppTokenForSubmodules(
    opts.ctx,
    "remote",
    tokenCtx,
    first,
    extras,
  );
  if (r?.token) {
    recordToken(trace, r, repos);
    return { token: r.token, ...(r.repositories ? { tokenRepositories: r.repositories } : {}) };
  }

  // 5. PUBLIC github.com repo → clone anonymously (nothing to ship). FAST PATH
  //    ONLY: isPublicRepo is unauthenticated + rate-limited (60/hr/IP) and fails
  //    closed, so a "no" here means "not proven public", NEVER "private" — step 2
  //    is the real authority when a server executor exists. Kept for cloud clones
  //    (no executor to probe with) and as a cheap early out.
  if (opts.owner && opts.repo && (await isPublicRepo(opts.owner, opts.repo))) {
    trace.source = "none (public repo)";
    return { anonymous: true };
  }

  // 6. Docker clone-on-server with nothing shippable: degrade to an api-host
  //    clone (clone on THIS host, transfer the context) rather than hard-failing
  //    after the server was already provisioned. The clone runs on THIS host, so
  //    a LOCAL credential is valid (flagged apiHostFallback so callers never ship
  //    it off-host).
  if (opts.allowApiHostFallback) {
    const local = await resolveLocalCredential(opts.ctx, tokenCtx, trace, extras);
    return { ...local, apiHostFallback: true };
  }

  // Otherwise surface the standard actionable error (requireTokenFor throws).
  await requireTokenFor(opts.ctx, "remote", tokenCtx);
  // Unreachable: requireTokenFor always throws when no token is resolvable.
  return {};
}

/**
 * Can a clone run ON THE BUILD HOST with this credential, or must it fall back to cloning on the
 * orchestrator and shipping the context?
 *
 * ONE definition, because two would drift into a deploy that falls back while the UI promised it
 * wouldn't. It lived inline in `build-pipeline` as an unnamed boolean, which meant the only way to
 * find out whether "On the server" would actually work was to start a deploy and read the log.
 *
 * Five things qualify, and the reasons they do are not interchangeable:
 *   - `ambient`   — the server already has its own git access; nothing needs to move.
 *   - `ssh`       — a key we can ship and use there (server key or per-repo deploy key).
 *   - `relay`     — the desktop relay forwards the identity for the duration.
 *   - `anonymous` — a public repo needs no credential at all.
 *   - `token` WITHOUT `apiHostFallback` — an App/PAT usable off-host. The flag is the whole
 *     point: a token carrying it is a LOCAL credential for cloning on THIS host, so treating
 *     token-presence alone as "shippable" would send a credential somewhere it can't authenticate
 *     and leak it off-host on the way.
 *
 * The BARE runtime always clones on the target and is gated by preflight separately, so callers
 * apply this to the docker runtime only.
 */
export function cloneOnServerAvailable(
  // The REAL credential type, not a hand-written subset: `ambient` is an object (`{ via }`), and
  // a structural copy that guessed `boolean` typechecked while reading the same field.
  cred: Pick<
    BuildGitCredential,
    "ambient" | "relay" | "ssh" | "anonymous" | "token" | "apiHostFallback"
  >,
): { available: true } | { available: false; reason: string } {
  if (cred.ambient) return { available: true };
  if (cred.relay === true) return { available: true };
  if (cred.ssh) return { available: true };
  if (cred.anonymous === true) return { available: true };
  if (cred.token && !cred.apiHostFallback) return { available: true };
  return {
    available: false,
    reason:
      "the server has no GitHub identity of its own, no App/PAT token is available, and no git " +
      "identity could be forwarded",
  };
}
