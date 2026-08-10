/**
 * Deploy the control plane ITSELF as a real, deploy-only app.
 *
 * The Openship self-app (project `appTemplateId === "openship"`) runs as a bare
 * host process supervised by `openship up` (launchd/systemd). To make it a
 * genuine deployment — real row + `activeDeploymentId` + routes/SSL owned by the
 * normal pipeline — without a SECOND process binding the port, we create an
 * ADOPT deployment: `meta:{deployTarget:"local", runtimeMode:"bare", adopt:true}`.
 *
 *   - `ensureAdoptDeployment` — idempotent: create (or resume/activate) the
 *     adopt deployment and drive it through the pipeline's terminal path
 *     (`createQueuedDeployment` → `runtime.deploy({adopt})` → `onSuccess`). The
 *     bare runtime's adopt branch only health-probes the port; it never starts a
 *     unit. Infra-free (constructs a bare runtime directly, so it never touches
 *     OpenResty) → cross-platform.
 *   - `provisionSelfAppEdge` — the custom-domain edge: install toolchain +
 *     takeover (`ensureSelfEdgeInfra`), then register the route via the pipeline
 *     (`reapplyProjectLiveRoutes`) and issue the cert via the pipeline
 *     (`manageDomainSsl`). Linux + root only.
 *   - `registerSelfAdoptReconcile` — boot hook: backfill the adopt deployment
 *     for existing installs, sync `project.port` to the live dashboard port
 *     (drifts across restarts), self-heal the custom route/cert, refresh the
 *     public URL. Replaces the old `registerSelfEdge` hook.
 *
 * All auth/zero-auth/cookie gates stay env-driven elsewhere; nothing here feeds
 * a "public" signal into them.
 */

import { repos, db, schema, eq, type Project, type Deployment } from "@repo/db";
import { BareRuntime } from "@repo/adapters";
import { safeErrorMessage, UNLIMITED_RESOURCES } from "@repo/core";
import { env } from "../../config/env";
import { registerStartupHook } from "./index";
import { ensureSelfEdgeInfra, type SelfEdgeOptions } from "./self-edge";
import { linkSelfAppServices } from "./self-services";
import {
  createQueuedDeployment,
  type DeploymentConfigSnapshot,
} from "../../modules/deployments/build.service";
import { onSuccess } from "../../modules/deployments/deployment-lifecycle";
import type { DeploymentMeta } from "../deployment-runtime";
import { reapplyProjectLiveRoutes } from "../../modules/domains/project-route.service";
import { describeTlsIssuedElsewhere, manageDomainSsl, tlsIssuedElsewhere } from "../domain-ssl";
import { refreshSelfAppPublicUrl } from "../public-url";

const APP_SLUG = "openship";
const APP_TEMPLATE_ID = "openship";
const BOOT_BACKOFFS = [15_000, 45_000, 120_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isLinuxRoot(): boolean {
  return (
    process.platform === "linux" &&
    (typeof process.getuid !== "function" || process.getuid() === 0)
  );
}

function isAdoptDeployment(dep: Deployment | null | undefined): boolean {
  return !!dep && (dep.meta as DeploymentMeta | null)?.adopt === true;
}

/** Minimal snapshot for an adopt deployment — only the read-relevant fields
 *  matter; the placeholders are never consumed (no build; adopt skips deploy). */
function adoptSnapshot(project: Project, dashPort: number): DeploymentConfigSnapshot {
  return {
    organizationId: project.organizationId,
    repoUrl: "",
    branch: project.gitBranch ?? "main",
    framework: project.framework ?? "node",
    buildImage: "",
    runtimeImage: "",
    packageManager: "",
    installCommand: "",
    buildCommand: "",
    outputDirectory: "",
    productionPaths: [],
    volumes: [],
    rootDirectory: ".",
    port: dashPort,
    startCommand: "",
    resources: null,
    buildResources: null,
    hasServer: true,
    hasBuild: false,
    deployTarget: "local",
    runtimeMode: "bare",
    adopt: true,
  };
}

/**
 * Ensure the self-app has a real ADOPT deployment (idempotent, race-safe).
 * Returns the active adopt deployment, or null if the project doesn't exist.
 */
export async function ensureAdoptDeployment(
  projectId: string,
  dashPort: number,
): Promise<Deployment | null> {
  const project = await repos.project.findById(projectId);
  if (!project) return null;

  // Already adopted + active → done.
  if (project.activeDeploymentId) {
    const active = await repos.deployment.findById(project.activeDeploymentId);
    if (isAdoptDeployment(active)) return active!;
  }

  // Reuse a prior adopt row rather than create a duplicate: a ready-but-inactive
  // one just needs activating; an in-flight one (crash between create and
  // onSuccess) gets finished. A fresh create would 403 against the
  // one-active-per-project partial index if an in-flight row still holds it.
  let dep: Deployment | null = null;
  const latest = await repos.deployment.findLatestByProject(projectId);
  if (isAdoptDeployment(latest)) {
    if (latest!.status === "ready") {
      await repos.project.setActiveDeployment(projectId, latest!.id);
      return latest!;
    }
    dep = latest!;
  }

  if (!dep) {
    dep = await createQueuedDeployment({
      projectId,
      organizationId: project.organizationId,
      branch: project.gitBranch ?? "main",
      environment: "production",
      framework: project.framework ?? "node",
      meta: adoptSnapshot(project, dashPort),
      envVars: null,
      trigger: "adopt",
    });
  }

  const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
  const buildSessionId = session?.id ?? dep.id;

  // Exercise the first-class adopt mode via a bare runtime constructed DIRECTLY
  // (not resolveDeploymentPlatform) so we never build the OpenResty infra
  // provider here — that mkdir's /usr/local/openresty and would fail on
  // macOS/non-root. The adopt branch only health-probes the port.
  let containerId = dep.id;
  try {
    const result = await new BareRuntime().deploy({
      deploymentId: dep.id,
      projectId,
      buildSessionId,
      environment: "production",
      port: dashPort,
      envVars: {},
      // No caps: this is the control plane on the operator's own host, and
      // BareRuntime is a host process — it has no cgroup to apply them to
      // anyway. The old hardcoded 0.5-core/512 MB literal read like a real
      // limit on Openship itself, which it never was.
      resources: { ...UNLIMITED_RESOURCES },
      adopt: true,
    });
    containerId = result.containerId ?? dep.id;
  } catch (err) {
    console.warn(`[self-deploy] adopt probe failed (continuing): ${safeErrorMessage(err)}`);
  }

  await onSuccess(
    { project, dep, buildSessionId, persistLogs: () => [], provisioned: {} },
    { containerId, durationMs: 0 },
  );

  // A containerized install (`openship up` on Linux) runs Openship as a compose
  // stack; link those containers to this project so its Apps & Services tab shows
  // the real thing instead of "No apps or services yet". Best-effort + idempotent
  // — a bare install has nothing to link and this no-ops.
  await linkSelfAppServices(projectId, dep.id).catch((err) =>
    console.warn(`[self-deploy] service linking skipped: ${safeErrorMessage(err)}`),
  );

  return dep;
}

export interface SelfEdgeStepProgress {
  onLog?: (message: string, level?: "info" | "warn" | "error") => void;
  onStep?: (
    step: "edge" | "route" | "ssl",
    status: "installing" | "installed" | "failed",
  ) => void;
  backoffs?: number[];
}

/**
 * Are ports 80/443 ours (or free) to serve TLS on? A FOREIGN proxy still holding
 * them means an ACME HTTP-01 fetch would hit IT, not us → the cert 404s with an
 * opaque "challenge failed", and we must never blind-kill it. So both the initial
 * provision AND the every-boot reconcile gate on this: if blocked, skip routing +
 * cert and tell the operator to migrate via the wizard/dashboard. Read-only,
 * best-effort (a probe failure does NOT block — never a false stop).
 */
async function foreignProxyBlocksEdge(
  log?: (message: string, level?: "info" | "warn" | "error") => void,
): Promise<{ blocked: boolean; owner?: string }> {
  try {
    const { foreignProxyOnEdge } = await import("@repo/adapters");
    const { sshManager } = await import("../ssh-manager");
    // Probe the HOST's :80/:443, not the api container's netns — the host channel is
    // LocalExecutor bare, SSH→host when containerized (OPENSHIP_HOST_SSH_*). Pooled,
    // so there's nothing to dispose (see withHostExecutor).
    const { blocked, owner } = await sshManager.withHostExecutor((exec) =>
      foreignProxyOnEdge(exec),
    );
    if (!blocked) return { blocked: false };
    log?.(
      `Not issuing TLS: ${owner} still owns ports 80/443, so Openship isn't the reverse proxy yet — ` +
        `an ACME challenge would hit it, not us. Re-run setup (or Domains → migrate) to take over.`,
      "error",
    );
    return { blocked: true, owner };
  } catch {
    return { blocked: false };
  }
}

/**
 * Custom-domain edge for the self-app: install the toolchain + take over
 * 80/443, then hand routing + cert to the NORMAL pipeline (route via
 * `reapplyProjectLiveRoutes`, cert via `manageDomainSsl` — both resolve the
 * local bare provider from the adopt deployment's meta). Linux + root only; the
 * caller must have run `ensureAdoptDeployment` first (route needs an active
 * deployment). Returns whether a cert was issued.
 */
export async function provisionSelfAppEdge(
  projectId: string,
  hostname: string,
  dashPort: number,
  progress: SelfEdgeStepProgress = {},
  // `managedEdgeSyncedByCaller` is not a `SelfEdgeOptions` field on purpose — that
  // type describes the INFRA install (takeover/migrate) and is forwarded verbatim to
  // `ensureSelfEdgeInfra`, which has no business knowing about Cloud's edge.
  options?: SelfEdgeOptions & { managedEdgeSyncedByCaller?: boolean },
): Promise<{ verified: boolean; expiresAt?: string; reason?: string }> {
  const log = progress.onLog;

  // 1. Toolchain install + optional 80/443 takeover/migrate (no route/cert).
  progress.onStep?.("edge", "installing");
  const infra = await ensureSelfEdgeInfra({ onLog: log }, options);
  if (!infra.ok) {
    progress.onStep?.("edge", "failed");
    return { verified: false, reason: infra.reason };
  }
  progress.onStep?.("edge", "installed");

  // Hard gate: never touch routing/cert unless OUR OpenResty owns 80/443 (takeover
  // skipped / partial / respawned would otherwise 404 the ACME challenge opaquely).
  if ((await foreignProxyBlocksEdge(log)).blocked) {
    progress.onStep?.("route", "failed");
    return { verified: false, reason: "edge_not_owned" };
  }

  // 2. Route hostname → 127.0.0.1:dashPort via the pipeline (owns the vhost +
  //    the ACME-challenge location).
  progress.onStep?.("route", "installing");
  const project = await repos.project.findById(projectId);
  if (!project) {
    progress.onStep?.("route", "failed");
    return { verified: false, reason: "no_project" };
  }
  try {
    await reapplyProjectLiveRoutes(project, [], {
      isSelfApp: true,
      // The free-domain wizard has already registered the slug on Cloud's edge via
      // `ensureManagedEdgeProxy` before calling us; re-syncing it here would issue a
      // second target challenge and reset the first one's token mid-check.
      managedEdgeSyncedByCaller: options?.managedEdgeSyncedByCaller,
    });
  } catch (err) {
    log?.(safeErrorMessage(err), "error");
    progress.onStep?.("route", "failed");
    return { verified: false, reason: "route_failed" };
  }
  progress.onStep?.("route", "installed");
  log?.(`routing ${hostname} → http://127.0.0.1:${dashPort}`);

  // Does this hostname's TLS come from somewhere else — Cloud's *.opsh.io edge, the
  // operator's own ingress, an uploaded cert? Asked of the DOMAIN ROW, which is
  // where that fact already lives, rather than taken as a boolean from the caller:
  // the free-domain registration writes `domainType: "free"` before calling us, so
  // the row already says so and can't disagree with the argument.
  //
  // Stopping here is an optimization and an honest log line, not the safety net —
  // `manageDomainSsl` refuses the same domains on its own (see tlsIssuedElsewhere).
  // Without it we'd announce an "Issue SSL certificate" step that is never going to
  // issue one.
  const domainRow = await repos.domain.findByHostname(hostname).catch(() => null);
  const elsewhere = domainRow ? tlsIssuedElsewhere(domainRow) : null;
  if (elsewhere) {
    log?.(describeTlsIssuedElsewhere(elsewhere, hostname));
    return { verified: true };
  }

  // 3. Issue the cert via the pipeline (ACME HTTP-01 through the resolved local
  //    provider). Retry so a not-yet-propagated A record doesn't hard-fail —
  //    the HTTP vhost keeps answering ACME between tries.
  progress.onStep?.("ssl", "installing");
  const backoffs = progress.backoffs ?? BOOT_BACKOFFS;
  // Remember the last real failure so the FINAL line reports WHY (not just
  // "retry on next boot") — it's the line the CLI/dashboard surfaces.
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      const res = await manageDomainSsl(hostname, { action: "provision", projectId });
      if (res.verified) {
        log?.(`TLS certificate issued for ${hostname} (expires ${res.expiresAt || "?"})`);
        progress.onStep?.("ssl", "installed");
        return { verified: true, expiresAt: res.expiresAt };
      }
      lastError = res.reason ?? lastError;
      log?.(
        `certificate not ready (${res.reason ?? "pending"})${attempt < backoffs.length ? " — retrying" : ""}`,
        "warn",
      );
    } catch (err) {
      lastError = safeErrorMessage(err);
      log?.(`cert error: ${lastError}`, "error");
    }
    if (attempt < backoffs.length) await sleep(backoffs[attempt]);
  }
  progress.onStep?.("ssl", "failed");
  log?.(
    lastError
      ? `Couldn't issue TLS for ${hostname}: ${lastError} — it serves over HTTP and retries on next boot.`
      : `could not issue TLS for ${hostname} yet — will retry on next boot (site still serves over HTTP).`,
    "warn",
  );
  return { verified: false, reason: "cert_pending" };
}

/** Locate the self-app project across the cloud-linked / founding-admin org.
 *  Returns null before setup has run (no admin / no self-app yet). */
async function findSelfAppProject(): Promise<Project | null> {
  const linked = await repos.settings.listCloudLinkedOrgIds().catch(() => [] as string[]);
  for (const org of linked) {
    const p = await repos.project.findBySlugInOrg(org, APP_SLUG);
    if (p && p.appTemplateId === APP_TEMPLATE_ID) return p;
  }
  const [admin] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.autoProvisioned, false))
    .orderBy(schema.user.createdAt)
    .limit(1);
  if (admin) {
    const p = await repos.project.findBySlugInOrg(`org_${admin.id}`, APP_SLUG);
    if (p && p.appTemplateId === APP_TEMPLATE_ID) return p;
  }
  return null;
}

/**
 * Boot hook: reconcile the self-app deployment + route on every start.
 * Self-hosted only (register.ts modes). NOT gated on OPENSHIP_PUBLIC_URL so
 * free/byo boxes reconcile too. First boot (no self-app) is a clean no-op.
 */
/**
 * Reconcile the self-app's domain ROWS with the hostname this box is actually
 * reached on (`OPENSHIP_PUBLIC_URL`, set by the CLI at install time).
 *
 * Two jobs:
 *
 * 1. CREATE the row when the env hostname has none. An install that set
 *    OPENSHIP_PUBLIC_URL but never completed a self-register (the compose wizard
 *    used to skip the custom-domain call entirely) ends up reachable on that
 *    hostname with ZERO domain rows — so Domains & Routes reads "No domains yet"
 *    on a box that is plainly serving that domain, and none of the per-domain UI
 *    (routes, rules, SSL state) has anything to attach to. The env var IS an
 *    operator-expressed preference: they typed it in the wizard or passed
 *    --public-url. Recording it is reconciliation, not invention.
 *
 *    The row is created BYO-shaped (`externalIngress`, `sslStatus: "external"`):
 *    if OUR edge had provisioned this domain, self-register would already have
 *    written the row, so reaching here means TLS is terminated by something we
 *    don't manage. Claiming otherwise would show a cert lifecycle we don't own.
 *
 * 2. Promote it to PRIMARY. Domain rows accumulate — a free `*.opsh.io` from one
 *    run, a custom domain from the next — and whichever was written last used to
 *    keep the primary flag, which is how a never-verified subdomain came to be
 *    displayed as the project's address.
 *
 * No-ops when the env URL is unset or unparseable.
 */
async function reconcileSelfAppPrimaryDomain(projectId: string): Promise<void> {
  const raw = env.OPENSHIP_PUBLIC_URL?.trim();
  if (!raw) return;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return;
  }
  if (!host) return;

  const rows = await repos.domain.listByProject(projectId);
  let wanted = rows.find((d) => d.hostname.toLowerCase() === host);

  if (!wanted) {
    // findOrCreate (not create) so a concurrent boot/self-register can't produce
    // a duplicate row for the same hostname.
    wanted = await repos.domain.findOrCreate({
      projectId,
      hostname: host,
      domainType: "custom",
      isPrimary: true,
      externalIngress: true,
      verified: true,
      verifiedAt: new Date(),
      status: "active",
      sslStatus: "external",
    });
    console.log(
      `[self-deploy] recorded self-app domain ${host} from OPENSHIP_PUBLIC_URL ` +
        `(no row existed — install did not register it)`,
    );
  }

  if (wanted.isPrimary) return;
  // The repo owns the promote+demote pair (one primary per project) — don't
  // re-implement the flag juggling here.
  await repos.domain.setPrimary(projectId, wanted.id);
  console.log(`[self-deploy] primary domain set to ${wanted.hostname} (from OPENSHIP_PUBLIC_URL)`);
}

export function registerSelfAdoptReconcile(): void {
  registerStartupHook({
    id: "self-app:reconcile",
    modes: ["desktop", "selfhosted"],
    run: async () => {
      const project = await findSelfAppProject();
      if (!project) return;

      // Roll back a migrate/takeover that crashed mid-flight so 80/443 aren't
      // left dark. Best-effort; root Linux only.
      if (isLinuxRoot()) {
        try {
          const { recoverInterruptedTakeover } = await import("@repo/adapters");
          const { sshManager } = await import("../ssh-manager");
          // Recover takeover on the HOST (local bare, SSH→host containerized).
          await sshManager.withHostExecutor((exec) =>
            recoverInterruptedTakeover(exec, (e) => console.log(`[self-deploy] ${e.message}`)),
          );
        } catch {}
      }

      const dashPort = env.OPENSHIP_DASHBOARD_PORT || 3001;

      // (a) Backfill / ensure the adopt deployment (existing installs predate it).
      await ensureAdoptDeployment(project.id, dashPort).catch((err) =>
        console.warn(`[self-deploy] ensureAdoptDeployment failed: ${safeErrorMessage(err)}`),
      );

      // (a2) Link the stack's own containers as this project's services. Runs on
      //      EVERY boot, not just when the adopt deployment is created:
      //      ensureAdoptDeployment early-returns for an install that already has
      //      one, so an existing install would otherwise never get its services —
      //      which is exactly the "No apps or services yet" a CLI-installed box
      //      showed while five Openship containers were running. Also keeps the
      //      image tags current after an upgrade.
      const activeDeploymentId = (await repos.project.findById(project.id))?.activeDeploymentId ?? null;
      await linkSelfAppServices(project.id, activeDeploymentId).catch((err) =>
        console.warn(`[self-deploy] service linking failed: ${safeErrorMessage(err)}`),
      );

      // (a3) Make the domain the operator actually reaches this box on the PRIMARY
      //      one. An install that registered a free `*.opsh.io` and later attached
      //      a real domain ended up with the stale free row still flagged primary,
      //      so the Domains tab presented a "Pending" subdomain as the project's
      //      address while the box was being served on the custom one. The env
      //      public URL is the unambiguous signal (it's what the CLI configured
      //      the box with), so trust it over insertion order.
      await reconcileSelfAppPrimaryDomain(project.id).catch((err) =>
        console.warn(`[self-deploy] primary-domain reconcile failed: ${safeErrorMessage(err)}`),
      );

      // (b) Sync project.port to the live dashboard port (it can change across
      //     restarts). reapply targets domain.targetPort ?? project.port.
      if (project.port !== dashPort) {
        await repos.project
          .update(project.id, { port: dashPort })
          .catch((err) => console.warn(`[self-deploy] port sync failed: ${safeErrorMessage(err)}`));
      }

      // (c) Self-heal the local-edge route + cert (Linux + root only).
      //
      // FREE domains are included: Cloud terminates their TLS and forwards to :80
      // on this box, so the local edge still needs the vhost. Gating this on
      // "custom" meant an install whose edge was down during registration could
      // never recover — the domain resolved and 404'd forever. Cert re-issue below
      // is skipped for free (Cloud owns that cert), route repair is not.
      const primary = await repos.domain.getPrimaryByProject(project.id);
      if (
        primary &&
        (primary.domainType === "custom" || primary.domainType === "free") &&
        !primary.externalIngress &&
        isLinuxRoot()
      ) {
        const fresh = await repos.project.findById(project.id);
        // Don't retry the route+cert against a foreign proxy on every boot — that's
        // the loop that spun forever on a box where the takeover never completed.
        const blocked = (await foreignProxyBlocksEdge((m) => console.warn(`[self-deploy] ${m}`))).blocked;
        if (fresh && !blocked) {
          try {
            await reapplyProjectLiveRoutes(fresh, [], { isSelfApp: true });
          } catch (err) {
            console.warn(`[self-deploy] route reapply failed: ${safeErrorMessage(err)}`);
          }
          // Same question as everywhere else, same answer: free (Cloud terminates),
          // external ingress, and uploaded certs are not certbot's to re-issue.
          if (!tlsIssuedElsewhere(primary) && primary.sslStatus !== "active") {
            try {
              await manageDomainSsl(primary.hostname, { action: "provision", projectId: project.id });
            } catch (err) {
              console.warn(`[self-deploy] cert re-issue failed: ${safeErrorMessage(err)}`);
            }
          }
        }
      }

      // (d) Warm the public-URL cache from the (now verified) primary domain.
      await refreshSelfAppPublicUrl().catch(() => {});
    },
  });
}
