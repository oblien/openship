/**
 * Single source of truth for the CLONE decision: where the repo gets cloned and
 * what credential that clone needs.
 *
 * This was previously derived independently in two places — the build pipeline
 * (the adapter's `cloneOnServer` flag + git-token purpose) and preflight
 * (`dockerClonesOnTarget`
 * + the remote-clone credential checks). Because the same decision was computed
 * from slightly different expressions, they drifted: preflight would pass a
 * config the pipeline then rejected (e.g. an api-host clone that preflight knew
 * was local, but the pipeline demanded a remote App/PAT token for). Both callers
 * now go through `resolveClonePlan`, so preflight verifies exactly what the
 * pipeline will do.
 *
 * The "credential actually available? → fall back to api-host" adjustment stays
 * in the pipeline (`effectiveCloneOnTarget`) because it depends on the resolved
 * token, which is runtime state, not config.
 */

export interface ClonePlanInput {
  /** Resolved deploy target for this build. */
  effectiveTarget: "local" | "server" | "cloud";
  /** Target server id (server deploys only). */
  serverId?: string | null;
  /** Resolved runtime is bare (host process) vs docker (sandbox). The pipeline
   *  passes `runtime.name === "bare"`; preflight passes `runtimeMode === "bare"`
   *  — each from its own source, kept as an input so neither has to know the
   *  other's variable. */
  runtimeIsBare: boolean;
  /** Per-deploy clone strategy for docker/server deploys ("api-host" default). */
  cloneStrategy?: "api-host" | "server" | null;
  /** Where the BUILD runs — used only to decide the clone's credential purpose
   *  (a local build always clones on this machine). */
  buildStrategy?: "local" | "server";
  /** Whether this instance is the desktop app (relay is desktop-only). */
  isDesktop: boolean;
  /** Forward the operator's git identity to the server for an on-server clone.
   *  Tri-state: `true`/`undefined` = forward when possible (the secure + atomic
   *  default for a desktop server clone); `false` = opt out (force an api-host
   *  clone + context transfer). Whether it ACTUALLY forwards still hinges on a
   *  real SSH tunnel + a local `gh` identity, probed at runtime by the pipeline /
   *  resolver — this only expresses the operator's preference. */
  forwardGitCredentials?: boolean | null;
  /** Repo is hosted on GitHub (`gitProvider === "github"` / has a parsed owner) →
   *  the server can download the source tarball directly (source-tarball.ts), so
   *  docker can acquire on the server without the explicit `cloneStrategy ===
   *  "server"` opt-in, skipping the orchestrator clone + context transfer.
   *  Whether it ACTUALLY runs on the server still depends on a shippable
   *  credential (resolved later; degrades to an api-host clone otherwise). The
   *  adapter re-validates the URL (github + https) before downloading and falls
   *  back to clone. Local/imported projects → false → unchanged. */
  repoIsGithub?: boolean;
  /** How Docker reaches its daemon. Source can be prepared on the target only
   *  when that transport also carries a command executor (SSH). Socket/TCP
   *  builds receive a context prepared on the API host. Omitted for non-Docker
   *  runtimes and retained as SSH-compatible for legacy callers. */
  dockerTransport?: "socket" | "ssh" | "tcp";
}

export interface ClonePlan {
  /** Physical auth/filesystem boundary where source acquisition happens. */
  sourceLocation: "api-host" | "target" | "cloud-workspace";
  /** The clone runs through the target's command executor. Bare server builds
   *  always do; Docker only can when its daemon transport is SSH. */
  cloneRunsOnTarget: boolean;
  /** The DOCKER-only target clone (excludes bare, which has its own hard-fail
   *  preflight checks). This is preflight's warn-case. */
  dockerClonesOnTarget: boolean;
  /** BuildStrategy to resolve the clone credential with (resolveBuildGitToken):
   *  "local" → local gh / broad resolver chain; "server" → shippable App/PAT. */
  cloneCredentialPurpose: "local" | "server";
  /** Desktop relay eligible: forward the operator's gh identity to the server for
   *  an on-server clone (nothing persisted). Requires the desktop app + opt-in. */
  relayEligible: boolean;
}

/**
 * The CONFIG-level relay gate, on its own so preflight and the pipeline can't
 * disagree about it. Whether a relay would actually clone additionally needs a
 * forwardable local identity (`hasLocalGitIdentity`) and a real reverse tunnel
 * (`executor.reverseForward`) — both runtime state, checked by their owners.
 *
 * Desktop-only is deliberate and load-bearing: the relay vends the operator's
 * account-wide gh token on demand, so its trust boundary is "one operator's
 * machine → their own server". A multi-tenant self-hosted box does not have that
 * boundary; it uses per-server credentials or its own ambient git access instead.
 */
export function relayConfigEligible(input: {
  isDesktop: boolean;
  forwardGitCredentials?: boolean | null;
}): boolean {
  return input.isDesktop && input.forwardGitCredentials !== false;
}

export function resolveClonePlan(input: ClonePlanInput): ClonePlan {
  const onServer = input.effectiveTarget === "server";
  // Only an SSH Docker transport has both a remote daemon AND a command channel
  // that can acquire source beside it. A socket/TCP transport can build there,
  // but its context must be prepared by the API host. Undefined preserves the
  // old remote-SSH assumption for callers that do not construct Docker runtimes.
  const dockerCanCloneOnTarget =
    input.dockerTransport === undefined || input.dockerTransport === "ssh";
  const localDockerBuildRequested =
    input.buildStrategy === "local" && input.cloneStrategy !== "server";

  // Docker acquires source ON THE TARGET when the deploy opted in
  // (cloneStrategy="server") OR the repo is a GitHub HTTPS remote — the server
  // downloads the tarball directly, skipping the orchestrator clone + context
  // transfer. Bare has its own always-on-server path (below), so it's excluded
  // here. Whether it truly runs on the target still hinges on a shippable
  // credential; effectiveCloneOnTarget degrades to an api-host clone otherwise
  // (allowApiHostFallback is driven by dockerClonesOnTarget).
  const dockerServerSide =
    onServer &&
    !input.runtimeIsBare &&
    dockerCanCloneOnTarget &&
    !localDockerBuildRequested &&
    (input.cloneStrategy === "server" || input.repoIsGithub === true);

  // Pipeline: the clone runs on the target (bare always; docker per above).
  const cloneRunsOnTarget =
    onServer && !!input.serverId && (input.runtimeIsBare || dockerServerSide);

  // Preflight warn-case + api-host-fallback gate: DOCKER (non-bare) acquiring on
  // the server. Bare is handled by the separate hard-fail remote-build checks.
  const dockerClonesOnTarget = dockerServerSide;

  // The clone's credential purpose follows WHERE THE CLONE RUNS, not where the
  // build runs: a local build clones on this machine, and a server deploy that
  // isn't cloning on the server clones on the api-host (both local → gh OK).
  // Everything else (on-server clone, cloud workspace clone) is off-host → remote.
  //
  // Stated as "off-host unless proven otherwise": the clone runs HERE unless it
  // runs on a server, or it's a cloud deploy building in the cloud workspace.
  //
  // #346 — this was `buildStrategy === "local" || onServer`, which silently
  // omitted the LOCAL target. A local deploy has no server to clone on, so the
  // clone always runs here; but no stack declares `defaultBuildStrategy`, so
  // `resolveStrategy` hands back "server" to every caller that omits it (MCP, the
  // CLI, CI, webhooks — the dashboard always sends it explicitly, which is why
  // only non-dashboard deploys broke). That tagged a host-local clone "server",
  // whose chain refuses the non-shippable gh-cli token, and the deploy hard-failed
  // "No GitHub token available … (purpose: remote)" on a host that could clone fine.
  //
  // Preflight's checkRemoteCloneToken already short-circuits `effectiveTarget ===
  // "local"` to pass, so it green-lit the very deploy the pipeline then rejected —
  // the preflight/pipeline drift this function exists to make impossible, surviving
  // because the rule lived inline in preflight and not in the shared plan. Keep the
  // two agreeing: a local target is a host-local clone on BOTH sides.
  //
  // apiHostClone MUST imply !cloneRunsOnTarget — otherwise a contradictory config
  // (buildStrategy="local" + cloneStrategy="server") would tag an on-server clone
  // as local and ship the operator's local gh/OAuth token off-host to the remote.
  const sourceLocation: ClonePlan["sourceLocation"] = cloneRunsOnTarget
    ? "target"
    : input.effectiveTarget === "cloud" && input.buildStrategy !== "local"
      ? "cloud-workspace"
      : "api-host";

  return {
    sourceLocation,
    cloneRunsOnTarget,
    dockerClonesOnTarget,
    cloneCredentialPurpose: sourceLocation === "api-host" ? "local" : "server",
    // Forward is the DEFAULT for a desktop server clone (secure + atomic: clone
    // on the build host with the operator's gh identity, nothing persisted),
    // opt-out via forwardGitCredentials === false. Real capability (SSH tunnel +
    // local gh) is verified at runtime; this is the config-level eligibility.
    relayEligible: cloneRunsOnTarget && relayConfigEligible(input),
  };
}
