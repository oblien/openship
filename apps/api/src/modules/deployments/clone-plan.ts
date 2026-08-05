/**
 * Single source of truth for the CLONE decision: where the repo gets cloned and
 * what credential that clone needs.
 *
 * This was previously derived independently in two places — the build pipeline
 * (`cloneOnServer` + the git-token purpose) and preflight (`dockerClonesOnServer`
 * + the remote-clone credential checks). Because the same decision was computed
 * from slightly different expressions, they drifted: preflight would pass a
 * config the pipeline then rejected (e.g. an api-host clone that preflight knew
 * was local, but the pipeline demanded a remote App/PAT token for). Both callers
 * now go through `resolveClonePlan`, so preflight verifies exactly what the
 * pipeline will do.
 *
 * The "credential actually available? → fall back to api-host" adjustment stays
 * in the pipeline (`effectiveCloneOnServer`) because it depends on the resolved
 * token, which is runtime state, not config.
 */

export interface ClonePlanInput {
  /** Resolved deploy target for this build. */
  effectiveTarget: "local" | "server" | "cloud";
  /** Resolved runtime is bare (host process) vs docker (sandbox). The pipeline
   *  passes `runtime.name === "bare"`; preflight passes `runtimeMode === "bare"`
   *  — each from its own source, kept as an input so neither has to know the
   *  other's variable. */
  runtimeIsBare: boolean;
  /** Per-deploy clone strategy for docker/server deploys ("api-host" default). */
  cloneStrategy?: "api-host" | "server" | null;
  /** Where the BUILD runs. For cloud deployments, a local build acquires source
   *  on the API host before upload; a server build acquires it in the cloud. */
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
  /** Whether the resolved runtime/transport can acquire source on the target
   *  host. Docker-over-SSH can; Docker through a local socket/TCP transport
   *  cannot because its clone implementation runs in the API process. Bare
   *  runtimes have their own target-host source path and do not need this flag. */
  targetSourceCloneSupported?: boolean;
}

export type SourceExecutionSite = "api-host" | "target-host" | "cloud";

export interface ClonePlan {
  /** Where source acquisition physically executes. Credential selection and
   *  preflight checks MUST follow this value, never the deploy target alone. */
  sourceSite: SourceExecutionSite;
  /** True when the operator requested target-host acquisition but the selected
   *  runtime transport cannot execute it. The caller should surface the
   *  transparent API-host fallback. */
  targetCloneUnavailable: boolean;
  /** The clone runs directly on the deploy server — bare always, docker on the
   *  explicit "clone on the server" opt-in. (Pipeline's `cloneOnServer`.) */
  runsOnServer: boolean;
  /** The DOCKER-only on-server clone (excludes bare, which has its own hard-fail
   *  preflight checks). This is preflight's warn-case. */
  dockerClonesOnServer: boolean;
  /** The clone runs on the api-host / orchestrator (local to it) — so the local
   *  gh identity is valid and no shippable token is required. */
  runsLocally: boolean;
  /** BuildStrategy to resolve the clone credential with (resolveBuildGitToken):
   *  "local" → local gh / broad resolver chain; "server" → shippable App/PAT. */
  cloneBuildStrategy: "local" | "server";
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

  // Provider and source site are deliberately independent. GitHub repositories
  // may use the tarball optimization AFTER target-host acquisition is selected,
  // but being hosted on GitHub must never override an explicit "api-host"
  // choice. Bare runtimes always acquire on their target. Docker does so only
  // when requested AND its concrete transport implements that path.
  const dockerTargetRequested =
    onServer && !input.runtimeIsBare && input.cloneStrategy === "server";
  const targetCloneUnavailable =
    dockerTargetRequested && input.targetSourceCloneSupported !== true;
  const runsOnServer =
    onServer &&
    (input.runtimeIsBare ||
      (dockerTargetRequested && input.targetSourceCloneSupported === true));

  const sourceSite: SourceExecutionSite = runsOnServer
    ? "target-host"
    : input.effectiveTarget === "cloud" && input.buildStrategy !== "local"
      ? "cloud"
      : "api-host";

  // Preflight warn-case + api-host-fallback gate: DOCKER (non-bare) acquiring on
  // the server. Bare is handled by the separate hard-fail remote-build checks.
  const dockerClonesOnServer = runsOnServer && !input.runtimeIsBare;

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
  // runsLocally MUST imply !runsOnServer — otherwise a contradictory config
  // (buildStrategy="local" + cloneStrategy="server") would tag an on-server clone
  // as local and ship the operator's local gh/OAuth token off-host to the remote.
  const runsLocally = sourceSite === "api-host";

  return {
    sourceSite,
    targetCloneUnavailable,
    runsOnServer,
    dockerClonesOnServer,
    runsLocally,
    cloneBuildStrategy: runsLocally ? "local" : "server",
    // Forward is the DEFAULT for a desktop server clone (secure + atomic: clone
    // on the build host with the operator's gh identity, nothing persisted),
    // opt-out via forwardGitCredentials === false. Real capability (SSH tunnel +
    // local gh) is verified at runtime; this is the config-level eligibility.
    relayEligible: runsOnServer && relayConfigEligible(input),
  };
}
