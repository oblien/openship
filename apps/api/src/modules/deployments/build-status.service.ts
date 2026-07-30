import { repos } from "@repo/db";
import type { LogEntry } from "@repo/adapters";
import * as sessionManager from "./session-manager";
import { loadDeployment, type DeploymentConfigSnapshot } from "./build.service";
import { STEP_INDEX, STEP_PROGRESS } from "./build-steps";
import { isMultiServiceProject } from "./compose";
import { serviceKind } from "../../lib/deployable-service";
import { resolveProjectRouteState } from "../domains/project-route.service";

type SwarmRevisionDetail = {
  id: string;
  revision: number;
  sourceDigest: string | null;
  renderedDigest: string;
  applyStatus: string;
  createdAt: Date;
  appliedAt: Date | null;
  convergedAt: Date | null;
  serviceImages: Record<string, string>;
  manifest: Record<string, unknown>;
};

function resourceIdentities(manifest: Record<string, unknown>) {
  const identities = Array.isArray(manifest.resourceIdentities) ? manifest.resourceIdentities : [];
  return identities.flatMap((identity) => {
    if (!identity || typeof identity !== "object") return [];
    const value = identity as Record<string, unknown>;
    const kind = value.kind === "volume" || value.kind === "network" ? value.kind : null;
    const logicalName = typeof value.logicalName === "string" ? value.logicalName : null;
    const effectiveName = typeof value.effectiveName === "string" ? value.effectiveName : null;
    if (!kind || !logicalName || !effectiveName) return [];
    return [{
      kind,
      logicalName,
      effectiveName,
      external: value.external === true,
    }];
  });
}

function summarizeSwarmRevision(revision: SwarmRevisionDetail) {
  const routingMode = revision.manifest.routingMode === "openship-edge"
    ? "openship-edge"
    : "external";
  return {
    id: revision.id,
    revision: revision.revision,
    sourceDigest: revision.sourceDigest,
    renderedDigest: revision.renderedDigest,
    applyStatus: revision.applyStatus,
    createdAt: revision.createdAt,
    appliedAt: revision.appliedAt,
    convergedAt: revision.convergedAt,
    routingMode,
    serviceImages: Object.entries(revision.serviceImages).sort(([left], [right]) => left.localeCompare(right)),
    resourceIdentities: resourceIdentities(revision.manifest),
  };
}

function swarmRevisionDiff(current: SwarmRevisionDetail, previous: SwarmRevisionDetail | null) {
  if (!previous) return { previousRevision: null, changes: ["First OpenShip-managed revision for this stack."] };
  const changes: string[] = [];
  const currentImages = current.serviceImages;
  const previousImages = previous.serviceImages;
  for (const [serviceName, image] of Object.entries(currentImages)) {
    if (!previousImages[serviceName]) changes.push(`Added service image for ${serviceName}.`);
    else if (previousImages[serviceName] !== image) changes.push(`Updated image for ${serviceName}.`);
  }
  for (const serviceName of Object.keys(previousImages)) {
    if (!currentImages[serviceName]) changes.push(`Removed service image for ${serviceName}.`);
  }
  const currentResources = new Map(resourceIdentities(current.manifest).map((resource) => [
    `${resource.kind}:${resource.logicalName}`,
    resource.effectiveName,
  ]));
  const previousResources = new Map(resourceIdentities(previous.manifest).map((resource) => [
    `${resource.kind}:${resource.logicalName}`,
    resource.effectiveName,
  ]));
  for (const [key, effectiveName] of currentResources) {
    if (previousResources.has(key) && previousResources.get(key) !== effectiveName) {
      changes.push(`Changed effective ${key} identity.`);
    }
  }
  if (current.renderedDigest !== previous.renderedDigest && changes.length === 0) {
    changes.push("Rendered stack configuration changed.");
  }
  return {
    previousRevision: summarizeSwarmRevision(previous),
    changes,
  };
}

async function swarmDeploymentDetail(
  dep: { id: string; runtimeRef: unknown },
  project: { id: string; organizationId: string; activeDeploymentId: string | null },
  serviceStatuses: Array<{
    serviceId: string;
    serviceName: string | null;
    status: string;
    imageRef: string | null;
    imageDigest: string | null;
    errorMessage: string | null;
  }>,
) {
  const stack = await repos.swarmStack.getForProjectInOrganization(project.id, project.organizationId);
  if (!stack) return null;
  const runtimeRef = dep.runtimeRef && typeof dep.runtimeRef === "object" &&
    (dep.runtimeRef as { kind?: unknown }).kind === "swarm-stack"
    ? dep.runtimeRef as { stackName: string; managerServerId: string; clusterId: string; revisionId: string }
    : null;
  const revision = runtimeRef?.revisionId
    ? await repos.swarmStack.getRevisionInOrganization(runtimeRef.revisionId, project.organizationId)
    : null;
  const revisions = revision
    ? await repos.swarmStack.listRevisionsInOrganization(stack.id, project.organizationId)
    : [];
  const previousRevision = revision
    ? revisions.find((candidate) => candidate.revision === revision.revision - 1) ?? null
    : null;

  return {
    stackName: runtimeRef?.stackName ?? stack.stackName,
    managerServerId: runtimeRef?.managerServerId ?? stack.managerServerId,
    clusterId: runtimeRef?.clusterId ?? stack.clusterId,
    managementMode: stack.managementMode,
    sourceDigest: stack.sourceDigest,
    isActive: project.activeDeploymentId === dep.id,
    revision: revision ? summarizeSwarmRevision(revision) : null,
    revisionDiff: revision ? swarmRevisionDiff(revision, previousRevision) : null,
    services: serviceStatuses,
  };
}

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
  const phaseStatuses: Record<string, NonNullable<LogEntry["stepStatus"]>> = {};
  {
    const phaseStart: Record<string, number> = {};
    for (const entry of logEntries) {
      if (!entry.step || !entry.stepStatus) continue;
      phaseStatuses[entry.step] = entry.stepStatus;
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
  const swarmServiceStatuses = deploymentServices.map((service) => ({
    serviceId: service.serviceId,
    serviceName: service.serviceName,
    status: service.status,
    imageRef: service.imageRef,
    imageDigest: service.imageDigest,
    errorMessage: service.errorMessage ?? service.error,
  }));
  const swarm = snapshot?.orchestratorMode === "swarm"
    ? await swarmDeploymentDetail(dep, project, swarmServiceStatuses)
    : null;
  // A connection-loss deployment records the start of reconciliation in its
  // build log. The reconciler runs independently, so settle that phase from
  // durable deployment and revision truth after a restart or browser refresh.
  if (swarm && phaseStatuses["swarm-reconcile"] === "running" && dep.status !== "reconciling") {
    phaseStatuses["swarm-reconcile"] =
      dep.status === "ready" && swarm.revision?.applyStatus === "ready"
        ? "completed"
        : "failed";
  }

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
      orchestratorMode: snapshot?.orchestratorMode,
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
    phaseStatuses,
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
    // Advisory port-check results + dismissed targets, re-hydrated on refresh so
    // the "wrong port?" modal reappears (unless skipped) after a reload.
    portCheck: snapshot?.portCheck ?? null,
    portCheckSkipped: snapshot?.portCheckSkipped ?? [],
    // A still-open decision prompt (edge 80/443 takeover, port conflict) so a
    // refresh re-shows the modal immediately, before the SSE stream replays it.
    pendingPrompt: memSession?.currentPrompt ?? null,
    errorCode:
      dep.errorMessage?.includes("PORT_IN_USE") || dep.errorMessage?.includes("EADDRINUSE")
        ? "PORT_IN_USE"
        : undefined,
    projectType,
    swarm,
    ...composeData,
  };
}
