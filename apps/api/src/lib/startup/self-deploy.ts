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
import { safeErrorMessage } from "@repo/core";
import { env } from "../../config/env";
import { registerStartupHook } from "./index";
import { ensureSelfEdgeInfra, type SelfEdgeOptions } from "./self-edge";
import {
  createQueuedDeployment,
  type DeploymentConfigSnapshot,
} from "../../modules/deployments/build.service";
import { onSuccess } from "../../modules/deployments/deployment-lifecycle";
import type { DeploymentMeta } from "../deployment-runtime";
import { reapplyProjectLiveRoutes } from "../../modules/domains/project-route.service";
import { manageDomainSsl } from "../domain-ssl";
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
      resources: { cpuCores: 1, memoryMb: 512, diskMb: 1024 },
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

  return dep;
}

export interface SelfEdgeStepProgress {
  onLog?: (message: string, level?: "info" | "warn" | "error") => void;
  onStep?: (
    step: "openresty" | "route" | "ssl",
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
    const { createHostExecutor, foreignProxyOnEdge } = await import("@repo/adapters");
    // Probe the HOST's :80/:443, not the api container's netns — createHostExecutor
    // is LocalExecutor bare, SSH→host when containerized (OPENSHIP_HOST_SSH_*).
    const { blocked, owner } = await foreignProxyOnEdge(createHostExecutor());
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
  options?: SelfEdgeOptions,
): Promise<{ verified: boolean; expiresAt?: string; reason?: string }> {
  const log = progress.onLog;

  // 1. Toolchain install + optional 80/443 takeover/migrate (no route/cert).
  progress.onStep?.("openresty", "installing");
  const infra = await ensureSelfEdgeInfra({ onLog: log }, options);
  if (!infra.ok) {
    progress.onStep?.("openresty", "failed");
    return { verified: false, reason: infra.reason };
  }
  progress.onStep?.("openresty", "installed");

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
    await reapplyProjectLiveRoutes(project, [], { isSelfApp: true });
  } catch (err) {
    log?.(safeErrorMessage(err), "error");
    progress.onStep?.("route", "failed");
    return { verified: false, reason: "route_failed" };
  }
  progress.onStep?.("route", "installed");
  log?.(`routing ${hostname} → http://127.0.0.1:${dashPort}`);

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
          const { createHostExecutor, recoverInterruptedTakeover } = await import("@repo/adapters");
          // Recover takeover on the HOST (createHostExecutor: local bare, SSH→host containerized).
          await recoverInterruptedTakeover(createHostExecutor(), (e) => console.log(`[self-deploy] ${e.message}`));
        } catch {}
      }

      const dashPort = env.OPENSHIP_DASHBOARD_PORT || 3001;

      // (a) Backfill / ensure the adopt deployment (existing installs predate it).
      await ensureAdoptDeployment(project.id, dashPort).catch((err) =>
        console.warn(`[self-deploy] ensureAdoptDeployment failed: ${safeErrorMessage(err)}`),
      );

      // (b) Sync project.port to the live dashboard port (it can change across
      //     restarts). reapply targets domain.targetPort ?? project.port.
      if (project.port !== dashPort) {
        await repos.project
          .update(project.id, { port: dashPort })
          .catch((err) => console.warn(`[self-deploy] port sync failed: ${safeErrorMessage(err)}`));
      }

      // (c) Self-heal the custom local-edge route + cert (Linux + root only).
      const primary = await repos.domain.getPrimaryByProject(project.id);
      if (
        primary &&
        primary.domainType === "custom" &&
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
          if (primary.sslStatus !== "active") {
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
