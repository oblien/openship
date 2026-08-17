/**
 * Managed-edge INFRA for the self-app's custom domain: install OpenResty +
 * certbot and, when the operator consents, take over / migrate an existing
 * proxy on ports 80/443. That's ALL this module does now — it no longer owns
 * routing or cert issuance. The route (hostname → 127.0.0.1:dashPort) and the
 * Let's Encrypt cert are registered by the NORMAL deployment pipeline via
 * `reapplyProjectLiveRoutes` + `manageDomainSsl`, resolved from the self-app's
 * adopt deployment (see lib/startup/self-deploy.ts). This keeps the self-app on
 * the same routing/SSL path as every other app — no duplication.
 *
 * Single-flight so the boot reconcile + the wizard endpoint never install twice
 * at once. Linux only, and only where the resolver says we can elevate (root or
 * passwordless sudo) on a host family Openship has a package manager for; a no-op
 * elsewhere.
 */

import { env } from "../../config/env";
import { pinnedEdgeImage, withPinnedEdgeImage } from "../edge-image";
import { resolveAcmeProviderOptions } from "../acme-config";

export interface SelfEdgeInfraProgress {
  onLog?: (message: string, level?: "info" | "warn" | "error") => void;
}

export interface SelfEdgeInfraResult {
  ok: boolean;
  reason?: string;
  /**
   * The classified CAUSE behind `reason`, in the words of whoever diagnosed it.
   *
   * `reason` is a code callers branch on, so it cannot carry the diagnosis — and
   * every failure below already knows one: the resolver names the distro it refuses,
   * and a failed takeover knows whether the stop was refused unelevated, :80 stayed
   * bound, the vhost writes hit EACCES, or the previous proxy never came back.
   * Collapsing that to "migrate_failed" is the cause-less failure #490 and #509 were
   * both about — it sends an operator to retry an operation that cannot succeed as
   * this user. Never re-worded here: the text is whatever the diagnosing layer
   * produced, so one fault reads the same on every surface.
   */
  detail?: string;
  /** When reason === "edge_conflict": what holds 80/443 and how many sites it serves. */
  occupants?: string;
  siteCount?: number;
}

export interface SelfEdgeOptions {
  /** Operator accepted reclaiming ports 80/443 from an existing proxy. Without
   *  it, an occupied edge makes the install throw rather than blind-kill. */
  edgeTakeover?: boolean;
  /** Operator accepted MIGRATING the existing proxy's sites into Openship
   *  before taking over (full scan → import → takeover). */
  edgeMigrate?: boolean;
  /** Corrected static roots (keyed by primary hostname) the wizard copied into the
   *  edge's static bind mount host-side, for adopted static sites the container edge
   *  couldn't reach at their original docroot. Passed to `runEdgeTakeover`. See #456. */
  staticRootOverrides?: Record<string, string>;
}

let inFlight: Promise<SelfEdgeInfraResult> | null = null;

/**
 * Ensure OpenResty + certbot are installed (and optionally take over/migrate an
 * existing proxy). Single-flight. Returns `{ok:false, reason}` on a non-Linux host,
 * one we can't elevate on, one whose family we can't provision, or a failed migrate
 * — the caller treats that as "skip the local edge" (free/byo domains don't need it).
 */
export function ensureSelfEdgeInfra(
  progress?: SelfEdgeInfraProgress,
  options?: SelfEdgeOptions,
): Promise<SelfEdgeInfraResult> {
  if (inFlight) return inFlight;
  inFlight = runEnsure(progress, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runEnsure(
  progress?: SelfEdgeInfraProgress,
  options?: SelfEdgeOptions,
): Promise<SelfEdgeInfraResult> {
  const log = (message: string, level: "info" | "warn" | "error" = "info") => {
    if (progress?.onLog) progress.onLog(message, level);
    else console.log(`[edge] ${message}`);
  };

  // Docker-edge (compose): the edge runs as the `openship-edge` container bound
  // to host :80/:443 via host networking — there is NO host OpenResty to
  // apt-install, and a `LocalExecutor` here would target the api CONTAINER, not
  // the host. The route + cert are still applied through the containerized edge
  // by the normal pipeline (DockerEdgeExecutor). Freeing a foreign proxy off
  // :80/:443 is handled by `openship up` on the host, not from inside here.
  if (process.env.OPENSHIP_EDGE_MODE === "docker") {
    log("docker edge mode — edge runs as a container; skipping host OpenResty install.");
    return { ok: true };
  }

  if (process.platform !== "linux") {
    log("managed edge needs a Linux host — skipping (use a reverse proxy in front).", "warn");
    return { ok: false, reason: "not_linux" };
  }
  const {
    createExecutor,
    SystemManager,
    foreignProxyOnEdge,
    importSites,
    resolveEnvironment,
    runEdgeTakeover,
  } = await import("@repo/adapters");
  const executor = createExecutor(); // LocalExecutor — this same machine

  // Privilege and host support come from the resolver, on the SAME executor the
  // installer will use — so this gate and `prepareExecutor` (installer.ts) share one
  // cached measurement and cannot disagree about the box.
  //
  // The `getuid() !== 0` test this replaces refused every non-root operator, including
  // the ones with passwordless sudo whom the installer would have elevated: the managed
  // edge was declared impossible before the one component that knows how to elevate was
  // ever asked. Still ahead of the `deliver-managed-image` import below, so a box that
  // skips here also skips pulling the deploy runtime onto the boot path.
  const profile = await resolveEnvironment(executor);
  if (!profile.isRoot && !profile.canSudo) {
    const detail =
      `managed edge needs root to install OpenResty/certbot — this API runs as ` +
      `${profile.loginUser} with no passwordless sudo.`;
    log(`${detail} Skipping.`, "warn");
    return { ok: false, reason: "not_root", detail };
  }
  if (!profile.supported) {
    // Worth saying here rather than letting it surface as an OpenResty install failure
    // three steps later: the reason names the observed distro, and nothing downstream
    // adds information.
    const detail = profile.unsupportedReason;
    log(`managed edge can't be installed on this host — skipping. ${detail}`, "warn");
    return { ok: false, reason: "unsupported_host", ...(detail ? { detail } : {}) };
  }

  // Lazy, like @repo/adapters above: deliver pulls in the deploy runtime (db, ssh,
  // dockerode), which must stay off the boot path on the topologies that skip early.
  const { deliverManagedImage } = await import("../deliver-managed-image");

  // Stage-B APPLY, build-only: this host IS the target, so build the edge from our
  // source onto the local daemon before either bring-up path pulls the pinned tag.
  // serverId undefined ⇒ no transfer; prod (no checkout) ⇒ deliver no-ops.
  const deliverEdge = () =>
    deliverManagedImage({
      kind: "edge",
      image: pinnedEdgeImage(),
      targetExecutor: executor,
      onLog: (l) => log(l.message, l.level),
    });

  // Migrate: import the existing proxy's sites and take over 80/443. The
  // self-app's own route is added AFTER by the pipeline (reapplyProjectLiveRoutes),
  // not here — so no extraRoutes.
  if (options?.edgeMigrate) {
    await deliverEdge();
    const { status } = await foreignProxyOnEdge(executor);
    const scan = await importSites(executor, status);
    const { reservedOperatorDomains, trackImportedDomain } = await import("../imported-domain-track");
    const reservedDomains = await reservedOperatorDomains().catch(() => [] as string[]);
    const res = await runEdgeTakeover(
      executor,
      {
        status,
        sites: scan.sites,
        acmeEmail: env.OPENSHIP_ACME_EMAIL,
        nginx: resolveAcmeProviderOptions(),
        extraRoutes: [],
        reservedDomains,
        onRegistered: (info) =>
          void trackImportedDomain(info).catch((err) =>
            log(`domain row for ${info.domain} not tracked: ${(err as Error).message}`, "warn"),
          ),
        // Pin the edge the takeover installs. `setDefaultEdgeImage` at boot already
        // covers this, but state it here too: this is the ONE caller of
        // runEdgeTakeover, so leaving its `edgeImage` unset is what made the option
        // dead code — and a dead pin reads as "the takeover doesn't need one".
        edgeImage: pinnedEdgeImage(),
        // Corrected static roots the wizard copied host-side (#456); absent when the
        // operator left them or none were unreachable.
        ...(options?.staticRootOverrides ? { staticRootOverrides: options.staticRootOverrides } : {}),
      },
      (entry) => log(entry.message, entry.level),
    );
    // `runEdgeTakeover` reports its diagnosis in `warnings` — the refused stop, the
    // port that stayed bound, the vhosts it couldn't write, the proxy that didn't come
    // back — and only `ok` was ever read. Relay them verbatim rather than summarizing:
    // these are the sentences the CLI preflight and the deploy log already print, and a
    // paraphrase here is a second copy that drifts.
    for (const warning of res.warnings) log(warning, res.ok ? "warn" : "error");
    if (!res.ok) {
      const detail = res.warnings.join(" ");
      return { ok: false, reason: "migrate_failed", ...(detail ? { detail } : {}) };
    }
    return { ok: true };
  }

  // Halt + report: with no pre-authorized takeover, if a foreign proxy already
  // holds 80/443, do NOT install (OpenResty couldn't bind, and we never blind-kill
  // someone's proxy). Report what's there — and how many sites it serves — so the
  // operator re-runs with migrate/take-over, instead of a bare downstream cert error.
  if (!options?.edgeTakeover) {
    const { status, blocked, owner } = await foreignProxyOnEdge(executor);
    if (blocked) {
      let siteCount = 0;
      try {
        siteCount = (await importSites(executor, status)).sites.length;
      } catch {
        /* best-effort site count only */
      }
      const sitesNote = siteCount > 0 ? ` serving ${siteCount} site${siteCount === 1 ? "" : "s"}` : "";
      log(
        `An existing proxy (${owner})${sitesNote} is using ports 80 and 443. Openship needs its own ` +
          `load balancer (OpenResty) there for managed HTTPS — left it running. Re-run setup and choose ` +
          `migrate or take-over to continue.`,
        "warn",
      );
      return { ok: false, reason: "edge_conflict", occupants: owner, siteCount };
    }
  }

  // Bring up the edge (idempotent — the container edge, or bare OpenResty on a
  // Docker-less box). edgeTakeover authorizes reclaiming 80/443 from an existing
  // proxy without prompting.
  await deliverEdge();
  const installerConfig = withPinnedEdgeImage(
    options?.edgeTakeover
      ? { edgePolicy: { mode: "takeover" as const, stopTargets: [] } }
      : {},
  );
  const system = new SystemManager("bare", { executor, installerConfig });
  await system.ensureFeature("ssl", (entry) => log(entry.message));
  return { ok: true };
}
