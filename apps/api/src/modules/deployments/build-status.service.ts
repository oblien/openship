import { repos } from "@repo/db";
import type { LogEntry } from "@repo/adapters";
import * as sessionManager from "./session-manager";
import { loadDeployment, type DeploymentConfigSnapshot } from "./build.service";
import { STEP_INDEX, STEP_PROGRESS } from "./build-steps";
import { isMultiServiceProject } from "./compose";
import { serviceKind } from "../../lib/deployable-service";
import { resolveProjectRouteState } from "../domains/project-route.service";

// Read-only build/deploy status projection for the deployment-detail UI + the
// build-status poll. No side effects; derives progress/phase durations from the
// in-memory session (live truth) or the persisted build-session logs (terminal).
export async function getBuildSessionStatus(deploymentId: string) {
  const { dep, project } = await loadDeployment(deploymentId);

  const buildSessionRow = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);

  const memSession = sessionManager.getSession(deploymentId);
  const isActive =
    memSession != null && !["ready", "failed", "cancelled"].includes(memSession.status);

  const logEntries = isActive
    ? (memSession?.logs ?? (buildSessionRow?.logs as LogEntry[] | null) ?? [])
    : ((buildSessionRow?.logs as LogEntry[] | null) ?? memSession?.logs ?? []);
  // Filter out step-metadata entries - they drive the progress bar, not the
  // terminal. eventId is the entry's stable `seq` (falling back to the array
  // index for legacy rows persisted before seq existed) so it matches the live
  // SSE ids and survives the ring-buffer trim.
  const terminalEntries = logEntries
    .map((entry, index) => ({ entry, eventId: entry.seq ?? index }))
    .filter(({ entry }) => !(entry.step && entry.stepStatus));
  const logsText = terminalEntries.map(({ entry }) => entry.message).join("\n");
  const structuredLogs = terminalEntries.map(({ entry, eventId }) => ({
    text: entry.message,
    time: entry.timestamp,
    level: entry.level,
    serviceName: entry.serviceName,
    serviceId: entry.serviceId,
    rawData: entry.rawData,
    eventId,
  }));
  // Highest terminal seq the client will have after seeding from this snapshot —
  // it resumes the live stream from here (?since=), so it must be the absolute
  // seq, not an array index.
  const lastEventId = terminalEntries.reduce<number | undefined>(
    (max, { eventId }) => (max === undefined || eventId > max ? eventId : max),
    undefined,
  );

  // In-memory session is real-time truth (updated every phase transition).
  // DB build-session row only moves queued → building → final, so it's stale during deploy.
  const effectiveStatus = memSession
    ? memSession.status
    : buildSessionRow
      ? buildSessionRow.status
      : dep.status;

  // Route state is always resolved live from route rows.
  const snapshot = dep.meta as DeploymentConfigSnapshot | null;
  const routeState = await resolveProjectRouteState(project);

  // Resolve the target server's display name (when this deployed to a server),
  // so the detail UI can show "Server · <name>" rather than a raw id.
  const targetServer = snapshot?.serverId
    ? await repos.server.get(snapshot.serverId).catch(() => null)
    : null;

  // Derive step progress from persisted log entries when no active session
  let currentStep = 0;
  let progress = 0;
  if (isActive) {
    // Truly active session - frontend gets live progress via SSE, don't override
    currentStep = undefined as unknown as number;
    progress = undefined as unknown as number;
  } else if (effectiveStatus === "ready") {
    currentStep = 5; // past deploy → Ready terminal (steps: prepare,clone,install,build,deploy,ready)
    progress = 100;
  } else {
    for (const entry of logEntries) {
      if (entry.step && entry.step in STEP_INDEX) {
        const idx = STEP_INDEX[entry.step];
        if (idx >= currentStep) {
          currentStep = idx;
          progress = STEP_PROGRESS[entry.step];
          // If this step completed, advance progress beyond it
          if (entry.stepStatus === "completed") {
            progress = STEP_PROGRESS[entry.step] + 10;
          }
        }
      }
    }
    // For failed/cancelled, keep progress where it stopped
  }

  // Per-phase durations for the build-phases panel. The raw log entries (before
  // the terminal filter) carry each step's running→completed events with
  // timestamps; pair them per step. Keyed by step name (prepare/clone/…).
  const phaseDurations: Record<string, number> = {};
  {
    const phaseStart: Record<string, number> = {};
    for (const entry of logEntries) {
      if (!entry.step || !entry.stepStatus) continue;
      const t = new Date(entry.timestamp).getTime();
      if (!Number.isFinite(t)) continue;
      if (entry.stepStatus === "running") {
        phaseStart[entry.step] = t;
      } else if (entry.stepStatus === "completed" && phaseStart[entry.step] != null) {
        phaseDurations[entry.step] = Math.max(0, t - phaseStart[entry.step]);
      }
    }
  }

  const [deploymentServices, projectServices] = await Promise.all([
    repos.service.listByDeployment(deploymentId).catch(() => []),
    repos.service.listByProject(project.id).catch(() => []),
  ]);
  const isServiceDeployment =
    snapshot?.serviceDeploymentMode === "services" ||
    (
      snapshot?.serviceDeploymentMode !== "single" &&
      (
        !!snapshot?.composeDeployment ||
        deploymentServices.length > 0 ||
        projectServices.length > 0 ||
        isMultiServiceProject(project)
      )
    );
  const projectType = isServiceDeployment
    ? ("services" as const)
    : snapshot?.runtimeMode === "docker"
      ? ("docker" as const)
      : ("app" as const);

  const composeData =
    projectType === "services"
      ? {
          composeDeployment: snapshot?.composeDeployment ?? null,
          serviceStatuses: deploymentServices.map((service) => ({
            serviceId: service.serviceId,
            status: service.status,
            containerId: service.containerId,
            hostPort: service.hostPort,
            ip: service.ip,
            imageRef: service.imageRef,
          })),
          services: projectServices
            .filter((service) => service.enabled)
            .map((service) => ({
              serviceId: service.id,
              serviceName: service.name,
              image: service.image,
              build: service.build,
            })),
          // Full compose config from the immutable deployment snapshot — the
          // source of truth for editing, and the ONLY place it survives when a
          // deploy failed before its service rows were persisted. Compose-kind
          // only (monorepo sub-apps carry a different shape). The dashboard
          // hydrates config.services from this so "Edit Configuration" shows the
          // real compose wizard even with an empty service table.
          composeServices: (snapshot?.composeServices ?? []).filter(
            (s) => serviceKind(s) === "compose",
          ),
        }
      : {};

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
    status: effectiveStatus,
    is_active: isActive,
    logs: logsText,
    logEntries: structuredLogs,
    lastEventId,
    config: {
      repo: project.gitRepo,
      owner: project.gitOwner,
      projectName: project.name,
      framework: snapshot?.framework || project.framework,
      branch: dep.branch ?? project.gitBranch,
      // Build/deploy target — shown in Deployment Details. Sourced from the
      // immutable deployment snapshot so a loaded historical deploy is accurate.
      buildStrategy: snapshot?.buildStrategy,
      deployTarget: snapshot?.deployTarget,
      runtimeMode: snapshot?.runtimeMode,
      serverId: snapshot?.serverId,
      serverName: targetServer?.name ?? targetServer?.sshHost ?? null,
      publicEndpoints: routeState.publicEndpoints.map((endpoint) => ({
        id: endpoint.id,
        ...(endpoint.port !== undefined ? { port: String(endpoint.port) } : {}),
        ...(endpoint.targetPath ? { targetPath: endpoint.targetPath } : {}),
        domain: endpoint.domain || "",
        customDomain: endpoint.customDomain || "",
        domainType: endpoint.domainType || "free",
      })),
      buildCommand: snapshot?.buildCommand,
      outputDirectory: snapshot?.outputDirectory,
      installCommand: snapshot?.installCommand,
      startCommand: snapshot?.startCommand,
      rootDirectory: snapshot?.rootDirectory,
      hasServer: snapshot?.hasServer ?? !!snapshot?.startCommand?.trim(),
      serviceDeploymentMode: snapshot?.serviceDeploymentMode,
    },
    progress,
    currentStep,
    phaseDurations,
    screenshots: [],
    buildDurationMs: buildSessionRow?.durationMs ?? null,
    buildStartedAt: buildSessionRow?.startedAt?.toISOString() ?? null,
    failureMessage: effectiveStatus === "failed" ? dep.errorMessage || "" : "",
    // Surface the partial-deploy warning for any settled-but-not-failed state
    // (ready / partial_failure / reconciling) so it survives a refresh in a new
    // tab, not just while the SSE session says "ready".
    warningMessage:
      effectiveStatus !== "failed" && effectiveStatus !== "cancelled"
        ? snapshot?.composeDeployment?.warningMessage || snapshot?.deployWarning || ""
        : "",
    // Real persisted status (dep.status carries partial_failure; `status` above
    // stays SSE-facing "ready" so the build page still renders as finished) plus
    // the server-backed keep/reject decision so the "Action Required" banner +
    // modal reappear after a refresh, until the user keeps or rejects.
    deploymentStatus: dep.status,
    decisionPending: snapshot?.composeDeployment?.decision === "pending",
    partial: snapshot?.composeDeployment
      ? {
          total: snapshot.composeDeployment.totalServices,
          successful: snapshot.composeDeployment.successfulServices,
          failed: snapshot.composeDeployment.failedServices,
          failedServiceNames: snapshot.composeDeployment.failedServiceNames ?? [],
        }
      : null,
    previousActiveDeploymentId: snapshot?.previousActiveDeploymentId ?? null,
    errorCode:
      dep.errorMessage?.includes("PORT_IN_USE") || dep.errorMessage?.includes("EADDRINUSE")
        ? "PORT_IN_USE"
        : undefined,
    projectType,
    ...composeData,
  };
}
