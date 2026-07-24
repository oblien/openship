"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { Terminal } from "@xterm/xterm";
import { useToast } from "@/context/ToastContext";
import { useCloud } from "@/context/CloudContext";
import { canUseCloudConnection, usePlatform } from "@/context/PlatformContext";
import { useModal } from "@/context/ModalContext";
import { useGitHub } from "@/context/GitHubContext";
import type { BuildLog } from "@/utils/deploymentPhaseDetector";
import { useBuildStream } from "@/hooks/useSSEConnection";
import { deployApi, projectsApi } from "@/lib/api";
import { randomUUID } from "@/lib/random-uuid";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { ApiError, getApiErrorMessage } from "@/lib/api/client";
import { DeployCredentialModal } from "@/components/deployments/DeployCredentialModal";
import { useServerGitHubConnectModal } from "@/components/github/ServerGitHubConnect";
import type { DeploymentConfig, DeploymentState, DeploymentStatus, ServiceDeployStatus } from "./types";
import { syncActiveModeSnapshot } from "./mode-config";
import {
  BUILD_PHASES,
  DEFAULT_CONFIG,
  INITIAL_STATE,
  ensurePublicEndpoints,
  normalizeComposeService,
  publicEndpointsNeedCloud,
  resolveBuildElapsedMs,
  syncPublicEndpointState,
  usesServiceDeployment,
} from "./types";
import type { RawComposeService } from "./types";

const ERROR_DEBOUNCE_MS = 1000;
const MAX_RENDERED_BUILD_LOGS = 2000;
const BUILD_STATUS_POLL_MS = 3000;

// Map a getBuildStatus snapshot's per-service rows into UI service statuses.
// Shared by the initial hydrate (loadBuildSession) and the self-heal poll so
// both derive serviceStatuses identically. DB may store running/failed/pending/
// deploying/building/stopped; collapse build+deploy into "deploying" for the UI.
function mapServiceStatusesFromBuildStatus(data: any): ServiceDeployStatus[] {
  if (
    !(
      (data.projectType === "services" || data.projectType === "monorepo") &&
      data.services &&
      data.serviceStatuses
    )
  ) {
    return [];
  }
  return (data.services as any[]).map((svc: any) => {
    const sd = (data.serviceStatuses as any[]).find((s: any) => s.serviceId === svc.serviceId);
    const rawStatus = sd?.status ?? "pending";
    // Persisted rows use the canonical vocab (success/failure/missing/
    // indeterminate/skipped); live SSE rows use running/failed/deploying/
    // building. Collapse both into the UI's live status set.
    const status: ServiceDeployStatus["status"] =
      rawStatus === "running" || rawStatus === "success"
        ? "running"
        : rawStatus === "failed" || rawStatus === "failure" || rawStatus === "missing"
          ? "failed"
          : rawStatus === "deploying" || rawStatus === "building" || rawStatus === "indeterminate"
            ? "deploying"
            : "pending";
    return {
      serviceId: svc.serviceId,
      serviceName: svc.serviceName,
      status,
      containerId: sd?.containerId,
      hostPort: sd?.hostPort,
      image: svc.image,
      build: svc.build,
    } as ServiceDeployStatus;
  });
}

function serializeProjectPublicEndpoint(
  endpoint: DeploymentConfig["publicEndpoints"][number],
  hasServer: boolean,
) {
  return {
    ...(hasServer
      ? (endpoint.port ? { port: Number(endpoint.port) } : {})
      : { targetPath: endpoint.targetPath || "/" }),
    domain: endpoint.domain || undefined,
    customDomain: endpoint.customDomain || undefined,
    domainType: endpoint.domainType,
  };
}

function serializeBuildPublicEndpoint(
  endpoint: DeploymentConfig["publicEndpoints"][number],
  hasServer: boolean,
) {
  return {
    ...(hasServer
      ? (endpoint.port ? { port: endpoint.port } : {})
      : { targetPath: endpoint.targetPath || "/" }),
    domain: endpoint.domain,
    customDomain: endpoint.customDomain,
    domainType: endpoint.domainType,
  };
}

function extractErrorCode(err: unknown): string | null {
  if (err instanceof ApiError) {
    const body = err.body as Record<string, unknown> | undefined;
    if (body && typeof body.code === "string") return body.code;
  }
  return null;
}

function logTypeFromStreamMessage(level: unknown, text: string): BuildLog["type"] {
  if (level === "error") return "error";
  if (level === "success") return "success";

  const lower = text.toLowerCase();
  if (lower.includes("error") || lower.includes("fail")) return "error";
  if (lower.includes("success") || lower.includes("ready") || lower.includes("complete")) {
    return "success";
  }
  return "info";
}

function logTypeFromHydratedEntry(entry: Record<string, unknown>, text: string): BuildLog["type"] {
  if (entry.type === "error" || entry.level === "error") return "error";
  if (entry.type === "success") return "success";
  return logTypeFromStreamMessage(entry.level, text);
}

// Rebuild the terminal buffer from a getBuildStatus snapshot. Shared by the
// initial hydrate (loadBuildSession) and the self-heal poll. Structured
// logEntries preserve per-service serviceName (so compose tabs stay populated);
// the plain-text fallback has no attribution.
function mapBuildLogsFromStatus(data: any): BuildLog[] {
  if (Array.isArray(data.logEntries)) {
    return (data.logEntries as Record<string, unknown>[])
      .map((entry): BuildLog | null => {
        const text =
          typeof entry.text === "string"
            ? entry.text
            : typeof entry.message === "string"
              ? entry.message
              : "";
        if (!text.trim()) return null;
        return {
          type: logTypeFromHydratedEntry(entry, text),
          text,
          time:
            typeof entry.time === "string"
              ? entry.time
              : typeof entry.timestamp === "string"
                ? entry.timestamp
                : new Date().toISOString(),
          serviceName:
            typeof entry.serviceName === "string" && entry.serviceName.trim()
              ? entry.serviceName
              : undefined,
          serviceId:
            typeof entry.serviceId === "string" && entry.serviceId.trim()
              ? entry.serviceId
              : undefined,
          rawData: typeof entry.rawData === "string" ? entry.rawData : undefined,
          eventId: typeof entry.eventId === "number" ? entry.eventId : undefined,
        };
      })
      .filter((entry): entry is BuildLog => entry !== null);
  }
  if (data.logs) {
    return (data.logs as string)
      .split("\n")
      .filter((line: string) => line.trim())
      .map((line: string) => ({
        type: "info" as const,
        text: line,
        time: new Date().toISOString(),
      }));
  }
  return [];
}

const STEPS = [
  { label: "Preparing", icon: "server-59-1658435258.png" },
  { label: "Cloning", icon: "git%20branch-159-1658431404.png" },
  { label: "Installing", icon: "npm-184-1693375161.png" },
  { label: "Building", icon: "tools-118-1658432731.png" },
  { label: "Deploying", icon: "space%20rocket-85-1687505546.png" },
  { label: "Ready", icon: "check%20circle-68-1658234612.png" },
];

/**
 * Owns the build lifecycle: terminal, SSE stream, start/stop/redeploy/load.
 *
 * Receives `config` (read-only) and `setConfig` (for loadBuildSession which
 * restores config from the API).
 */
export function useDeploymentBuild(
  config: DeploymentConfig,
  setConfig: React.Dispatch<React.SetStateAction<DeploymentConfig>>,
) {
  const { showToast } = useToast();
  const { requireCloud } = useCloud();
  const { baseDomain, selfHosted, deployMode } = usePlatform();
  const { showModal, hideModal } = useModal();
  const openGithubConnect = useServerGitHubConnectModal();
  const { installUrl, state: githubState } = useGitHub();
  const [state, setState] = useState<DeploymentState>(INITIAL_STATE);

  // ── Refs ──────────────────────────────────────────────────────────────────

  const terminalRef = useRef<Terminal | null>(null);
  const pendingLogsBuffer = useRef<Uint8Array[]>([]);
  const isTerminalReady = useRef<boolean>(false);
  const canStreamContainer = useRef<boolean>(false);
  const lastEventIdRef = useRef<number | undefined>(undefined);
  const lastErrorRef = useRef<{ message: string; timestamp: number } | null>(null);
  // Wall-clock of the last self-heal poll — rate-caps the leading poll so effect
  // re-creation (dep churn) can't burst getBuildStatus into a request storm.
  const lastBuildStatusPollRef = useRef(0);
  /** Wall-clock when each build phase (by step index) became current — used to
   *  derive live per-phase durations as the build advances. Reset per deploy. */
  const phaseStartRef = useRef<Record<number, number>>({});

  // ── Derived ───────────────────────────────────────────────────────────────

  const deploymentStatus: DeploymentStatus = state.deploymentCanceled
    ? "cancelled"
    : state.deploymentFailed
      ? "failed"
      : state.deploymentSuccess
        ? "ready"
        : state.currentStepIndex >= 4
          ? "deploying"
          : "building";

  // ── Terminal helpers ──────────────────────────────────────────────────────

  const writeToTerminal = useCallback((data: Uint8Array) => {
    if (terminalRef.current && isTerminalReady.current) {
      terminalRef.current.write(data);
    } else if (usesServiceDeployment(config)) {
      return;
    } else {
      pendingLogsBuffer.current.push(data);
    }
  }, [config]);

  const flushPendingLogs = useCallback(() => {
    if (terminalRef.current && pendingLogsBuffer.current.length > 0) {
      pendingLogsBuffer.current.forEach((data) => terminalRef.current?.write(data));
      pendingLogsBuffer.current = [];
    }
  }, []);

  // ── Stream event handlers ─────────────────────────────────────────────────

  const handleSuccessMessage = useCallback((data?: any) => {
    const warningMessage = typeof data?.warningMessage === "string" ? data.warningMessage : "";
    const now = Date.now();

    setState((prev) => {
      // The final phase (deploy) completes via this success event, not a
      // currentStep transition — finalize its live duration here.
      const nextDurations = { ...prev.phaseDurations };
      const id = BUILD_PHASES[prev.currentStepIndex]?.id;
      const startedAt = phaseStartRef.current[prev.currentStepIndex];
      if (id && startedAt != null && nextDurations[id] == null) {
        nextDurations[id] = Math.max(0, now - startedAt);
      }
      return {
        ...prev,
        deploymentSuccess: true,
        deploymentFailed: false,
        deploymentCanceled: false,
        currentProgress: 100,
        currentStepIndex: 5,
        isDeploying: false,
        failureMessage: "",
        warningMessage,
        // A warning on success means a partial failure (some services failed):
        // hold it for an explicit keep/reject decision. The server flag takes
        // over on refresh (loadBuildSession) — false once the user keeps it.
        decisionPending: data?.decisionPending ?? !!warningMessage,
        decisionFailedServiceIds: data?.partial?.failed ?? prev.decisionFailedServiceIds,
        // Advisory port-check rides the `complete` event; skips only ever arrive
        // via refresh (build-status), so keep the prior skip list here.
        portCheck: data?.portCheck ?? prev.portCheck,
        screenshots: data?.screenshots || prev.screenshots,
        projectId: data?.project_id || prev.projectId,
        phaseDurations: nextDurations,
      };
    });

    // Deploy changed the live release — drop cached project info so the project
    // view re-reads fresh (clears the "New commit"/"Action Required" banners).
    if (data?.project_id) invalidateProjectCaches(data.project_id);

    if (warningMessage) {
      const textEncoder = new TextEncoder();
      writeToTerminal(textEncoder.encode(`\r\n\x1b[33m Deployment completed with warnings: ${warningMessage}\x1b[0m\r\n`));
    }
  }, [writeToTerminal]);

  const handleFailureMessage = useCallback(
    (message?: string, errorCode?: string, errorDetails?: Record<string, unknown>) => {
      const errorMessage = message || "Build failed. Check logs for details.";
      const now = Date.now();

      if (lastErrorRef.current) {
        const elapsed = now - lastErrorRef.current.timestamp;
        if (lastErrorRef.current.message === errorMessage && elapsed < ERROR_DEBOUNCE_MS) {
          return;
        }
      }
      lastErrorRef.current = { message: errorMessage, timestamp: now };

      setState((prev) => ({
        ...prev,
        deploymentFailed: true,
        deploymentSuccess: false,
        isDeploying: false,
        failureMessage: errorMessage,
        warningMessage: "",
        errorCode: errorCode || "",
        errorDetails: errorDetails || null,
      }));

      const textEncoder = new TextEncoder();
      writeToTerminal(textEncoder.encode(`\r\n\x1b[31m Deployment Failed: ${errorMessage}\x1b[0m\r\n`));
      showToast(errorMessage, "error", "Deployment Failed");
    },
    [showToast, writeToTerminal],
  );

  const handleProgressUpdate = useCallback((currentStep: number, progress: number) => {
    const now = Date.now();
    // Mark when this phase became current (first sighting wins; running +
    // completed events for the same step share an index).
    if (phaseStartRef.current[currentStep] == null) {
      phaseStartRef.current[currentStep] = now;
    }
    setState((prev) => {
      // Finalize live durations for any phase we've advanced past.
      let nextDurations = prev.phaseDurations;
      for (let i = prev.currentStepIndex; i < currentStep; i++) {
        const id = BUILD_PHASES[i]?.id;
        const startedAt = phaseStartRef.current[i];
        if (id && startedAt != null && nextDurations[id] == null) {
          if (nextDurations === prev.phaseDurations) nextDurations = { ...prev.phaseDurations };
          nextDurations[id] = Math.max(0, now - startedAt);
        }
      }
      return {
        ...prev,
        currentStepIndex: currentStep,
        currentProgress: progress,
        phaseDurations: nextDurations,
      };
    });
  }, []);

  const handleCanceled = useCallback(
    (message?: string) => {
      const cancelMessage = message || "Deployment cancelled by user";
      const now = Date.now();

      if (lastErrorRef.current) {
        const elapsed = now - lastErrorRef.current.timestamp;
        if (lastErrorRef.current.message === cancelMessage && elapsed < ERROR_DEBOUNCE_MS) {
          return;
        }
      }
      lastErrorRef.current = { message: cancelMessage, timestamp: now };

      setState((prev) => ({
        ...prev,
        deploymentCanceled: true,
        deploymentFailed: false,
        deploymentSuccess: false,
        isDeploying: false,
        isStopping: false,
        failureMessage: cancelMessage,
        warningMessage: "",
      }));
    },
    [],
  );

  // ── Build stream (SSE) ────────────────────────────────────────────────────

  const buildStream = useBuildStream({
    terminalRef,
    autoWriteToTerminal: false,
    callbacks: {
      onLog: (message, rawText, rawBytes) => {
        if (message.eventId !== undefined) {
          if (
            lastEventIdRef.current !== undefined &&
            message.eventId <= lastEventIdRef.current
          ) {
            return;
          }
          lastEventIdRef.current = message.eventId;
        }
        if (rawBytes) {
          writeToTerminal(rawBytes);
        }
        if (rawText && rawText.trim().length > 0) {
          const serviceName =
            typeof message.serviceName === "string" && message.serviceName.trim()
              ? message.serviceName
              : undefined;
          // Capture into structured buildLogs (feeds the compose per-service
          // tabs) for any services deploy OR any line that carries a
          // serviceName. Do NOT gate solely on usesServiceDeployment(config):
          // `config` can still be unresolved when the first live per-service
          // lines arrive, which previously dropped them from the tabs until a
          // refresh rebuilt buildLogs from persisted logs. A serviceName only
          // ever appears on a services deploy, so single-app is unaffected.
          const serviceId =
            typeof message.serviceId === "string" && message.serviceId.trim()
              ? message.serviceId
              : undefined;
          if (usesServiceDeployment(config) || serviceName || serviceId) {
            const nextLog: BuildLog = {
              type: logTypeFromStreamMessage((message as { level?: unknown }).level, rawText),
              text: rawText,
              time: new Date().toISOString(),
              serviceName,
              serviceId,
              rawData: typeof message.data === "string" ? message.data : undefined,
            };
            setState((prev) => ({
              ...prev,
              buildLogs: [...prev.buildLogs, nextLog].slice(-MAX_RENDERED_BUILD_LOGS),
            }));
          }
        }
      },
      onPhaseChange: () => {},
      onProgress: handleProgressUpdate,
      onSuccess: (data) => {
        handleSuccessMessage(data);
        if (config.options.hasServer) {
          canStreamContainer.current = true;
        }
        buildStream.disconnect();
      },
      onFailure: (message, errorCode, errorDetails) => {
        handleFailureMessage(message, errorCode, errorDetails);
        buildStream.disconnect();
      },
      onPrompt: (prompt) => {
        setState((prev) => ({
          ...prev,
          pendingPrompt: {
            promptId: prompt.promptId,
            title: prompt.title,
            message: prompt.message,
            actions: prompt.actions,
            details: prompt.details,
          },
        }));
      },
      onServiceStatus: (svcStatus) => {
        setState((prev) => {
          const existing = prev.serviceStatuses.findIndex(
            (s) => s.serviceId === svcStatus.serviceId,
          );
          const updated = [...prev.serviceStatuses];
          const entry = {
            serviceId: svcStatus.serviceId,
            serviceName: svcStatus.serviceName,
            status: svcStatus.status,
            error: svcStatus.error,
            containerId: svcStatus.containerId,
            hostPort: svcStatus.hostPort,
          };
          if (existing >= 0) {
            updated[existing] = { ...updated[existing], ...entry };
          } else {
            updated.push(entry);
          }
          return { ...prev, serviceStatuses: updated };
        });
      },
      onCanceled: (message) => {
        buildStream.disconnect();
        handleCanceled(message);
        showToast(message || "Deployment cancelled", "success", "Cancelled");
      },
      onReconnected: () => {
        showToast("Reconnected successfully", "success", "Connected");
      },
    },
    onConnect: () => {},
    onDisconnect: () => {},
    onError: (error) => console.error("[Deployment] Build connection error:", error),
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  const startDeployment = useCallback(async (
    overrides?: {
      runtimeMode?: DeploymentConfig["runtimeMode"];
      // Applied to THIS deploy's payload directly, bypassing async React state
      // — lets the clone-strategy gate flip build-local for the in-flight
      // deploy without waiting for a re-render (updateConfig alone wouldn't be
      // seen by this closure).
      buildStrategy?: DeploymentConfig["buildStrategy"];
      saveConfigOnly?: boolean;
    },
  ): Promise<string | null> => {
    const saveConfigOnly = overrides?.saveConfigOnly === true;
    const isLocal = !!config.localPath;
    const isUpload = !!config.uploadSessionId;
    // A one-click app is a repo-less services project — no git/local source (its
    // prebuilt images are the source), so skip the git-completeness guard and the
    // git fields on ensure, exactly like local/upload.
    const isSourceless = isLocal || isUpload || !!config.isApp;
    if (!isSourceless && (!config.repo || !config.owner || !config.branch)) {
      showToast("Repository data is incomplete", "error", "Error");
      return null;
    }

    if (!config.framework || config.framework === "unknown") {
      showToast("Please select a framework", "error", "Error");
      return null;
    }

    lastErrorRef.current = null;

    const localBuildStartedAt = new Date().toISOString();
    // Save-only (Edit from the Runtime page) persists config and stops — it
    // never builds, so skip resetting the build/progress state.
    if (!saveConfigOnly) {
      phaseStartRef.current = {};
      setState((prev) => ({
        ...prev,
        isDeploying: true,
        isStopping: false,
        buildLogs: [],
        currentProgress: 0,
        currentStepIndex: 0,
        phaseDurations: {},
        deploymentSuccess: false,
        deploymentFailed: false,
        deploymentCanceled: false,
        failureMessage: "",
        warningMessage: "",
        decisionPending: false,
        decisionFailedServiceIds: [],
        portCheck: [],
        portCheckSkipped: [],
        errorCode: "",
        errorDetails: null,
        pendingPrompt: null,
        screenshots: [],
        serviceStatuses: [],
        buildStartedAt: localBuildStartedAt,
        buildDurationMs: null,
        buildRetryCarryMs:
          prev.deploymentFailed || prev.deploymentCanceled ? resolveBuildElapsedMs(prev) : 0,
      }));
    }

    // Hoisted so the catch block can show the credential modal with the
    // freshly-ensured project id — for first deploys, config.projectId is
    // still null at this point, which would disable the "Add a project
    // clone token" option.
    let ensuredProjectId: string | null = config.projectId ?? null;

    try {
      // ── Save-only (Edit from the Runtime page): the project ALREADY exists,
      // so persist build + runtime config in ONE atomic call (POST /:id/options)
      // and STOP. Deliberately does NOT call `ensure` (which would resend git +
      // publicEndpoints + a re-detected framework and clobber live config/routes)
      // and does NOT touch env (env has its own per-variable editor — a blind
      // replace here would wipe/corrupt masked secrets). No deploy. ────────────
      if (saveConfigOnly) {
        const projectId = config.projectId;
        if (!projectId) {
          showToast("Missing project — open this from the project's Runtime tab", "error", "Error");
          return null;
        }
        try {
          await projectsApi.setOptions(projectId, {
            framework: config.framework,
            packageManager: config.packageManager,
            buildImage: config.buildImage,
            installCommand: config.options.installCommand,
            buildCommand: config.options.buildCommand,
            startCommand: config.options.startCommand,
            outputDirectory: config.options.outputDirectory,
            productionPaths: config.options.productionPaths,
            rootDirectory: config.options.rootDirectory,
            productionPort:
              config.options.hasServer && config.options.productionPort
                ? Number(config.options.productionPort)
                : undefined,
            hasServer: config.options.hasServer,
            hasBuild: config.options.hasBuild,
            ...(config.runtimeMode === "bare" || config.runtimeMode === "docker"
              ? { runtimeMode: config.runtimeMode }
              : {}),
          });
          showToast("Configuration saved", "success", "Saved");
          return projectId;
        } catch (err) {
          // Surface the REAL error (no more opaque "some settings failed").
          showToast(getApiErrorMessage(err, "Failed to save configuration"), "error", "Save failed");
          return null;
        }
      }

      const isServiceDeployment = usesServiceDeployment(config);
      const isMonorepoDeployment = config.projectType === "monorepo";

      // Step 1: Ensure project exists
      const projectData = await projectsApi.ensure({
        projectId: config.projectId || undefined,
        name: config.projectName || config.repo || config.localPath?.split("/").pop() || "project",
        gitOwner: isSourceless ? undefined : config.owner || undefined,
        gitRepo: isSourceless ? undefined : config.repo || undefined,
        gitBranch: isSourceless ? undefined : config.branch || undefined,
        localPath: config.localPath || undefined,
        // Folder-upload projects: mark the source so it renders correctly and
        // can later be switched to a GitHub repo (Source tab / linkRepo).
        gitProvider: isUpload ? "upload" : undefined,
        framework: config.framework,
        packageManager: config.packageManager,
        buildImage: config.buildImage,
        buildCommand: config.options.buildCommand,
        outputDirectory: config.options.outputDirectory,
        productionPaths: config.options.productionPaths || undefined,
        installCommand: config.options.installCommand,
        startCommand: config.options.startCommand,
        rootDirectory: config.options.rootDirectory,
        port: config.options.hasServer && config.options.productionPort
          ? Number(config.options.productionPort)
          : undefined,
        publicEndpoints: !isServiceDeployment && !isMonorepoDeployment
          ? config.publicEndpoints.map((endpoint) => (
              serializeProjectPublicEndpoint(endpoint, config.options.hasServer)
            ))
          : undefined,
        hasServer: config.options.hasServer,
        hasBuild: config.options.hasBuild,
        // Monorepo: persist the per-sub-app slices + shared workspace install.
        projectType: isMonorepoDeployment ? "monorepo" : undefined,
        monorepoApps: isMonorepoDeployment
          ? (config.monorepoApps ?? []).map((app) => ({
              name: app.name,
              rootDirectory: app.rootDirectory,
              framework: app.framework,
              packageManager: app.packageManager,
              buildImage: app.buildImage,
              installCommand: app.installCommand || undefined,
              buildCommand: app.buildCommand || undefined,
              startCommand: app.startCommand || undefined,
              outputDirectory: app.outputDirectory || undefined,
              port: app.port ? Number(app.port) : undefined,
              enabled: app.enabled,
              exposed: true,
            }))
          : undefined,
        monorepoWorkspace: isMonorepoDeployment && config.monorepoWorkspace
          ? {
              packageManager: config.monorepoWorkspace.packageManager,
              prepareCommand: config.monorepoWorkspace.prepareCommand,
            }
          : undefined,
        // Persist the repo's vercel.json routing so the backend compiles it to
        // OpenResty at deploy (single-domain rewrites, redirects, headers).
        routingConfig: config.routingConfig ?? undefined,
      });

      if (!projectData.success || !projectData.project_id) {
        showToast(projectData.error || "Failed to create project", "error", "Error");
        setState((prev) => ({ ...prev, isDeploying: false }));
        return null;
      }

      // Capture for the catch block — buildAccess may throw preflight
      // errors but the project row already exists at this point.
      ensuredProjectId = projectData.project_id;

      // Step 2: Create deployment with config snapshot + env vars
      const envVarsMap: Record<string, string> = {};
      if (config.envVars && config.envVars.length > 0) {
        for (const ev of config.envVars) {
          if (ev.key.trim()) {
            envVarsMap[ev.key] = ev.value;
          }
        }
      }

      const data = await deployApi.buildAccess({
        projectId: projectData.project_id,
        branch: config.branch || undefined,
        // Folder-upload: adopt the uploaded source (workspace or staging dir).
        uploadSessionId: config.uploadSessionId || undefined,
        envVars: Object.keys(envVarsMap).length > 0 ? envVarsMap : undefined,
        // "None" routing → explicit [] (no public URL). Must be [], not
        // undefined: undefined makes the backend auto-derive a free subdomain.
        publicEndpoints: !isServiceDeployment
          ? config.noPublicRoute
            ? []
            : config.publicEndpoints.map((endpoint) => (
                serializeBuildPublicEndpoint(endpoint, config.options.hasServer)
              ))
          : undefined,
        buildStrategy:
          config.projectType === "docker" || isServiceDeployment
            ? "server"
            : (overrides?.buildStrategy ?? config.buildStrategy),
        deployTarget: config.deployTarget,
        // Only a server target uses serverId — never let a stale id ride along
        // with a cloud/local deploy (backend gates it too, but be explicit).
        serverId: config.deployTarget === "server" ? config.serverId : undefined,
        // Per-deploy git credential forwarding — only sent for a server target
        // (the only build that clones on-host). The API re-checks desktop +
        // server-build before honoring it.
        forwardGitCredentials:
          config.deployTarget === "server" && config.forwardGitCredentials === true
            ? true
            : undefined,
        // Clone location — only meaningful for a server target. Clone-on-server
        // is now the DEFAULT (secure, atomic: credential forwarded over the SSH
        // relay for the clone, never stored). Only an explicit "api-host" pick
        // (the advanced "clone on your device, then upload" option) sends
        // undefined so the backend clones on the orchestrator. The backend
        // degrades a server clone back to api-host if no credential can reach
        // the build host, so this default can never block a deploy.
        cloneStrategy:
          config.deployTarget === "server" && config.cloneStrategy !== "api-host"
            ? "server"
            : undefined,
        runtimeMode:
          config.projectType === "docker" || isServiceDeployment
            ? "docker"
            : (overrides?.runtimeMode ?? config.runtimeMode),
        // Send the mode for BOTH multi-app shapes so the operator's per-app vs
        // single choice reaches the backend. Monorepo was previously omitted,
        // leaving the backend to guess via shouldUseProjectServicePipeline.
        serviceDeploymentMode:
          config.projectType === "services" || config.projectType === "monorepo"
            ? config.serviceDeploymentMode
            : undefined,
        // Cloud resource tier only matters for a server-backed Oblien deploy.
        // Static (Pages) deploys and non-cloud targets ignore it.
        cloudResourceTier:
          config.deployTarget === "cloud" && config.options.hasServer
            ? config.cloudResourceTier
            : undefined,
        cloudResourceCustom:
          config.deployTarget === "cloud" &&
          config.options.hasServer &&
          config.cloudResourceTier === "custom"
            ? config.cloudResourceCustom
            : undefined,
        services: isServiceDeployment
          ? config.services.map((service) => ({
              name: service.name,
              image: service.image,
              build: service.build,
              dockerfile: service.dockerfile,
              ports: service.ports,
              dependsOn: service.dependsOn,
              environment: service.environment,
              volumes: service.volumes,
              command: service.command,
              restart: service.restart,
              exposed: service.exposed,
              exposedPort: service.exposedPort,
              domain: service.domain,
              customDomain: service.customDomain,
              domainType: service.domainType,
              // Multi-route: one entry per public port. Drop the UI-only id/
              // targetPath; the backend mirrors entry[0] → the scalar fields.
              publicEndpoints: service.publicEndpoints?.map((endpoint) => ({
                port: endpoint.port,
                domain: endpoint.domainType === "custom" ? undefined : endpoint.domain,
                customDomain: endpoint.domainType === "custom" ? endpoint.customDomain : undefined,
                domainType: endpoint.domainType,
              })),
            }))
          : undefined,
      });

      if (data.success && data.deployment_id) {
        setState((prev) => ({
          ...prev,
          deploymentId: data.deployment_id,
          projectId: data.project_id || projectData.project_id || prev.projectId,
        }));
        return data.deployment_id;
      } else {
        showToast(data.message || "Deployment failed", "error", "Error");
        setState((prev) => ({ ...prev, isDeploying: false }));
        return null;
      }
    } catch (err) {
      console.error("Deployment error:", err);
      const message = getApiErrorMessage(err, "Failed to start deployment");
      const errorCode = extractErrorCode(err);

      const canConnectCloud = canUseCloudConnection({ selfHosted, deployMode });
      const needsManagedProjectDomainHelp =
        canConnectCloud &&
        !usesServiceDeployment(config) &&
        config.deployTarget !== "cloud" &&
        publicEndpointsNeedCloud(config.publicEndpoints) &&
        errorCode === "CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN";
      const needsManagedComposeDomainHelp =
        canConnectCloud &&
        usesServiceDeployment(config) &&
        errorCode === "CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS";
      const needsCloudTargetHelp = errorCode === "CLOUD_REQUIRED_TARGET";
      // Clone-token preflight failures — server's runPreflightChecks
      // ran tokenFor("remote") and came up empty. Open the missing-
      // credential modal in place of the toast so the user has three
      // concrete recovery paths instead of a dead-end error.
      const needsCloneCredentialHelp =
        errorCode === "GITHUB_REMOTE_TOKEN_REQUIRED" ||
        errorCode === "GITHUB_APP_INSTALLATION_REQUIRED" ||
        errorCode === "GITHUB_CLI_REMOTE_BUILD_REJECTED";

      if (needsManagedProjectDomainHelp) {
        const openedModal = !requireCloud({
          feature: `Using free .${baseDomain} domains on your own server`,
          description: `Free .${baseDomain} domains are routed through Openship Cloud. To deploy this project to your own server, either connect Openship Cloud or switch this project to a custom domain.`,
          secondaryHint: "If you prefer to stay fully self-hosted, change the project domain to a custom domain and deploy again.",
        });
        if (!openedModal) {
          showToast(message, "error", "Error");
        }
      } else if (needsManagedComposeDomainHelp) {
        const openedModal = !requireCloud({
          feature: `Using free .${baseDomain} domains for your services`,
          description: `One or more exposed services use free .${baseDomain} domains. To deploy them to your own server, either connect Openship Cloud or switch those services to custom domains.`,
          secondaryHint: "Custom domains work without Openship Cloud. Free managed domains do not.",
        });
        if (!openedModal) {
          showToast(message, "error", "Error");
        }
      } else if (needsCloudTargetHelp) {
        const openedModal = !requireCloud("Deploying to Openship Cloud");
        if (!openedModal) {
          showToast(message, "error", "Error");
        }
      } else if (needsCloneCredentialHelp && config.owner) {
        let modalId = "";
        modalId = showModal({
          customContent: (
            <DeployCredentialModal
              trigger="preflight-fail"
              owner={config.owner}
              installUrl={installUrl ?? null}
              projectId={ensuredProjectId}
              serverId={config.serverId ?? null}
              deployTarget={config.deployTarget}
              buildStrategy={config.buildStrategy}
              selfHosted={selfHosted}
              ghCliAvailable={!!githubState?.sources.ghCli.available}
              onChoice={(choice) => {
                if (choice.kind === "build-local") {
                  setConfig((prev) => ({ ...prev, buildStrategy: "local" }));
                } else if (choice.kind === "connect-server-github" && config.serverId) {
                  openGithubConnect(config.serverId, {
                    onConnected: () =>
                      showToast(
                        "GitHub connected — deploy again to continue.",
                        "success",
                        "GitHub",
                      ),
                  });
                }
                hideModal(modalId);
              }}
              onDismiss={() => hideModal(modalId)}
            />
          ),
          maxWidth: "640px",
        });
      } else {
        showToast(message, "error", "Error");
      }
      setState((prev) => ({ ...prev, isDeploying: false }));
      return null;
    }
  }, [baseDomain, config, deployMode, hideModal, installUrl, openGithubConnect, requireCloud, selfHosted, setConfig, showModal, showToast]);

  // `startBuild` controls which SSE endpoint to hit:
  //   - true  → POST /:id/build, which ALSO kicks off the build. Now only
  //             a defensive fallback — every server-side build-creation path
  //             (`requestBuildAccess`, `redeployBuildSession`, etc.) calls
  //             `kickoffBuild` before returning, so callers should prefer
  //             `false` to avoid the empty-terminal race (see handleRedeploy
  //             and build page initialize for the symptom).
  //   - false → GET /:id/stream, attach-only. Used after initial deploy
  //             (where `requestBuildAccess` already kicked off the build),
  //             after redeploy (where `redeployBuildSession` did), and on
  //             page refresh via `loadBuildSession`.
  // Defaults to true for back-compat; new call sites should pass `false`.
  const connectToBuild = useCallback(async (deploymentId?: string, startBuild: boolean = true) => {
    const id = deploymentId || state.deploymentId;
    if (!id) {
      throw new Error("No deployment ID available");
    }
    await buildStream.connect(id, startBuild);
  }, [state.deploymentId, buildStream]);

  // Self-heal the services view when the live stream drops mid-deploy. The build
  // SSE can go terminal (a transient reconnect miss, a premature terminal event)
  // while the deploy is still running server-side — without this the UI freezes
  // on "Prepare" until a manual refresh. While the deployment is active and the
  // stream is NOT connected, poll getBuildStatus (the same source a refresh uses)
  // and merge the live-relevant fields so per-service progress advances on its own.
  useEffect(() => {
    const deploymentId = state.deploymentId;
    const active =
      state.isDeploying &&
      !state.deploymentSuccess &&
      !state.deploymentFailed &&
      !state.deploymentCanceled;
    if (!deploymentId || !active || buildStream.isConnected) return;

    let cancelled = false;
    const tick = async () => {
      lastBuildStatusPollRef.current = Date.now();
      try {
        const data = await deployApi.getBuildStatus(deploymentId);
        if (cancelled || !data?.success) return;
        const isActive = data.is_active;
        const status = data.status;
        const mapped = mapServiceStatusesFromBuildStatus(data);
        // The stream is detached, so live logs stopped flowing — refresh the
        // terminal buffer from the snapshot too (structured entries keep their
        // serviceName so per-service tabs repopulate). Keep lastEventIdRef in
        // sync so a later reconnect-replay dedups against what we just applied.
        const polledLogs = mapBuildLogsFromStatus(data);
        if (typeof data.lastEventId === "number") {
          lastEventIdRef.current = data.lastEventId;
        }
        setState((prev) => ({
          ...prev,
          currentProgress: data.progress ?? prev.currentProgress,
          currentStepIndex: data.currentStep ?? prev.currentStepIndex,
          isDeploying: isActive,
          deploymentSuccess: !isActive && status === "ready",
          deploymentFailed: !isActive && status === "failed",
          deploymentCanceled: !isActive && status === "cancelled",
          ...(mapped.length ? { serviceStatuses: mapped } : {}),
          ...(polledLogs.length > prev.buildLogs.length ? { buildLogs: polledLogs } : {}),
          ...(!isActive
            ? {
                failureMessage: data.failureMessage || prev.failureMessage,
                warningMessage: data.warningMessage || prev.warningMessage,
                decisionPending: !!data.decisionPending,
                decisionFailedServiceIds: data.partial?.failed ?? prev.decisionFailedServiceIds,
                portCheck: data.portCheck ?? prev.portCheck,
                portCheckSkipped: data.portCheckSkipped ?? prev.portCheckSkipped,
                errorCode: data.errorCode || prev.errorCode,
              }
            : {}),
        }));
        // Deploy settled while the stream was detached — stop reconnect churn.
        if (!isActive && !cancelled) buildStream.disconnect();
      } catch {
        // Transient poll error — keep trying on the next tick.
      }
    };

    // Leading poll only if we haven't polled within the interval. If this effect
    // is re-created rapidly (a dep changed identity across renders), the guard
    // skips the immediate poll so it can't storm the endpoint — the interval
    // still paces it at BUILD_STATUS_POLL_MS.
    if (Date.now() - lastBuildStatusPollRef.current >= BUILD_STATUS_POLL_MS) {
      void tick();
    }
    const interval = setInterval(tick, BUILD_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    state.deploymentId,
    state.isDeploying,
    state.deploymentSuccess,
    state.deploymentFailed,
    state.deploymentCanceled,
    buildStream.isConnected,
    buildStream.disconnect,
  ]);

  const loadBuildSession = useCallback(
    async (deploymentId: string): Promise<{ success: boolean; error?: string }> => {
      try {
        lastErrorRef.current = null;

        // Reset state immediately to avoid flashing stale data from previous deployment
        setState((prev) => ({
          ...INITIAL_STATE,
          deploymentId,
          buildRetryCarryMs: prev.deploymentId === deploymentId ? prev.buildRetryCarryMs : 0,
        }));

        const data = await deployApi.getBuildStatus(deploymentId);

        if (!data.success) {
          const errorMessage = data.error || "Failed to load build session";
          showToast(errorMessage, "error", "Error");
          return { success: false, error: errorMessage };
        }

        // Restore config from session
        if (data.config) {
          const apiConfig = data.config;
          const apiHasServer = apiConfig.hasServer !== undefined
            ? apiConfig.hasServer
            : config.options.hasServer;
          const normalizedEndpoints = ensurePublicEndpoints(
            apiConfig.publicEndpoints?.map((endpoint: {
              port?: string;
              targetPath?: string;
              domain?: string;
              customDomain?: string;
              domainType?: "free" | "custom";
            }) => {
              let cleanDomain = endpoint.domain || "";
              const dotIdx = cleanDomain.indexOf(".");
              if (dotIdx > 0) {
                cleanDomain = cleanDomain.slice(0, dotIdx);
              }

              return {
                id: randomUUID(),
                port: endpoint.port || "",
                targetPath: endpoint.targetPath || "",
                domain: cleanDomain,
                customDomain: endpoint.customDomain || "",
                domainType: endpoint.domainType || "free",
              };
            }),
            apiHasServer ? undefined : { targetPath: "/" },
          );

          setConfig((prev) => syncActiveModeSnapshot(syncPublicEndpointState({
            ...prev,
            projectId: data.project_id || prev.projectId,
            publicEndpoints: normalizedEndpoints,
            repo: apiConfig.repo || prev.repo,
            owner: apiConfig.owner || prev.owner,
            projectName: apiConfig.projectName || prev.projectName,
            framework: apiConfig.framework || prev.framework,
            packageManager: apiConfig.packageManager || prev.packageManager,
            buildImage: apiConfig.buildImage || prev.buildImage,
            branch: apiConfig.branch || prev.branch,
            // Actual build/deploy target of THIS deployment (from the snapshot),
            // so the detail UI reflects how it really ran, not the live default.
            buildStrategy: apiConfig.buildStrategy || prev.buildStrategy,
            deployTarget: apiConfig.deployTarget || prev.deployTarget,
            // Actual runtime isolation of THIS deployment (docker for compose),
            // so the target step's clone picker + summary reflect reality rather
            // than the "bare" default.
            runtimeMode: apiConfig.runtimeMode || prev.runtimeMode,
            serverId: apiConfig.serverId ?? prev.serverId,
            serverName: apiConfig.serverName ?? prev.serverName,
            envVars: apiConfig.envVars || prev.envVars,
            projectType: data.projectType || prev.projectType,
            modeSnapshots: (data.projectType || prev.projectType) === "services"
              ? prev.modeSnapshots
              : undefined,
            serviceDeploymentMode:
              apiConfig.serviceDeploymentMode ||
              (data.projectType === "services" ? "services" : "single"),
            // Full compose config from the deployment snapshot (getBuildStatus
            // returns it as `composeServices`). Hydrating config.services here
            // means the shared DeploymentProvider carries the real services into
            // "Edit Configuration" — so the compose wizard shows them even when
            // the service table is empty (e.g. a deploy that failed before its
            // rows were persisted). Falls back to whatever's already loaded.
            services: Array.isArray(data.composeServices)
              ? (data.composeServices as RawComposeService[]).map(normalizeComposeService)
              : prev.services,
            options: {
              buildCommand: apiConfig.buildCommand || prev.options.buildCommand,
              outputDirectory: apiConfig.outputDirectory || prev.options.outputDirectory,
              productionPaths: apiConfig.productionPaths || prev.options.productionPaths,
              installCommand: apiConfig.installCommand || prev.options.installCommand,
              startCommand: apiConfig.startCommand || prev.options.startCommand,
              productionPort: apiHasServer
                ? (normalizedEndpoints[0]?.port || prev.options.productionPort)
                : prev.options.productionPort,
              rootDirectory: apiConfig.rootDirectory || prev.options.rootDirectory,
              hasServer: apiHasServer,
              hasBuild: apiConfig.hasBuild !== undefined ? apiConfig.hasBuild : prev.options.hasBuild,
            },
          })));
        }

        // Parse existing logs. Compose needs structured entries so service tabs
        // keep serviceName/raw terminal data after refresh.
        const buildLogs: BuildLog[] = mapBuildLogsFromStatus(data);

        const isActive = data.is_active;
        const status = data.status;
        // A freshly-created (queued/building) deployment has no in-memory build
        // session yet, so `is_active` is momentarily false even though it IS
        // running — e.g. right after a retry/redeploy navigates here. Treat any
        // non-terminal status as live so we ATTACH the stream (buildStream
        // reconnects on "session not found" until the session spins up) and run
        // the self-heal poll, instead of freezing until a manual refresh.
        const isTerminal = status === "ready" || status === "failed" || status === "cancelled";
        const isLive = isActive || !isTerminal;

        setState((prev) => ({
          ...prev,
          deploymentId,
          projectId: data.project_id || prev.projectId,
          currentProgress: data.progress || 0,
          currentStepIndex: data.currentStep || 0,
          deploymentSuccess: !isActive && status === "ready",
          deploymentFailed: !isActive && status === "failed",
          deploymentCanceled: !isActive && status === "cancelled",
          isDeploying: isLive,
          screenshots: !isActive ? (data.screenshots || []) : [],
          failureMessage: !isActive ? (data.failureMessage || "") : "",
          warningMessage: !isActive ? (data.warningMessage || "") : "",
          decisionPending: !isActive ? !!data.decisionPending : false,
          decisionFailedServiceIds: !isActive ? (data.partial?.failed ?? []) : [],
          portCheck: !isActive ? (data.portCheck ?? []) : [],
          portCheckSkipped: !isActive ? (data.portCheckSkipped ?? []) : [],
          errorCode: !isActive ? (data.errorCode || "") : "",
          errorDetails: null,
          buildLogs,
          // Authoritative per-phase durations computed server-side from the
          // step events (live tracking is best-effort until this lands).
          phaseDurations: data.phaseDurations || {},
          buildDurationMs: data.buildDurationMs ?? null,
          buildStartedAt: data.buildStartedAt ?? null,
          buildRetryCarryMs: prev.buildRetryCarryMs,
          // Restore per-service statuses for compose AND monorepo projects.
          // Monorepo sub-apps fan out through the same multi-service pipeline,
          // so the same SSE statuses apply.
          serviceStatuses: mapServiceStatusesFromBuildStatus(data),
        }));

        // Hydrate current terminal output before subscribing.
        // For active sessions, track the last replayed event ID so SSE
        // replay does not duplicate logs after refresh.
        if (buildLogs.length > 0) {
          if (isActive && typeof data.lastEventId === "number") {
            lastEventIdRef.current = data.lastEventId;
          }
          const textEncoder = new TextEncoder();
          buildLogs.forEach((log) => {
            // Prefer the original terminal bytes when present (active-session
            // refresh): carriage returns / ANSI are preserved so replay
            // repaints exactly like the live stream. Persisted (finished)
            // entries are already collapsed to one clean line each server-side
            // (collapseTerminalLogs) and carry no rawData → the text path.
            if (log.rawData) {
              try {
                const binary = atob(log.rawData);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                writeToTerminal(bytes);
                return;
              } catch {
                /* corrupt base64 — fall back to the decoded text line */
              }
            }
            writeToTerminal(textEncoder.encode(`${log.text}\r\n`));
          });
        }

        // Handle scenarios
        if (isLive) {
          // History already seeded from the snapshot above; attach live from the
          // last seq we have so the stream sends ONLY new events (no re-replay).
          // When the session isn't up yet (just-created deploy), lastEventId is
          // absent and buildStream reconnects until it appears — no refresh needed.
          await buildStream.connect(
            deploymentId,
            false,
            typeof data.lastEventId === "number" ? data.lastEventId : undefined,
          );
        } else if (status === "ready") {
          handleSuccessMessage({
            screenshots: data.screenshots,
            project_id: data.project_id,
            warningMessage: data.warningMessage,
          });
          if (data.warningMessage) {
            showToast(data.warningMessage, "success", "Deployment Ready With Warnings");
          } else {
            showToast("Build completed successfully", "success", "Success");
          }
        } else if (status === "failed") {
          handleFailureMessage(data.failureMessage || "Build failed", data.errorCode);
        } else if (status === "cancelled") {
          handleCanceled(data.failureMessage || "Build was cancelled");
        }

        return { success: true };
      } catch (err) {
        console.error("Error loading build session:", err);
        const errorMessage = getApiErrorMessage(err, "Failed to load build session");
        showToast(errorMessage, "error", "Error");
        return { success: false, error: errorMessage };
      }
    },
    [buildStream, setConfig, showToast, writeToTerminal, handleSuccessMessage, handleFailureMessage, handleCanceled],
  );

  const stopDeployment = useCallback(async () => {
    if (state.isStopping || !state.deploymentId) return;

    setState((prev) => ({ ...prev, isStopping: true }));

    try {
      const response = await deployApi.cancel(state.deploymentId);
      if (response.success) {
        buildStream.disconnect();
        canStreamContainer.current = false;
        handleCanceled(response.message);
        showToast(response.message || "Deployment cancelled", "success", "Cancelled");
      } else {
        showToast(response.error || "Failed to stop deployment", "error", "Error");
      }
    } catch (error) {
      console.error("[DeploymentContext] Error stopping deployment:", error);
      showToast(getApiErrorMessage(error, "Failed to stop deployment"), "error", "Error");
    } finally {
      setState((prev) => ({ ...prev, isStopping: false }));
    }
  }, [buildStream, canStreamContainer, state.deploymentId, state.isStopping, showToast, handleCanceled]);

  const redeploy = useCallback(
    async (deploymentId: string): Promise<string | null> => {
      if (!deploymentId) {
        showToast("Deployment ID not provided", "error", "Error");
        setState((prev) => ({
          ...prev,
          isDeploying: false,
          deploymentFailed: true,
          failureMessage: "Failed to start redeployment",
          warningMessage: "",
        }));
        return null;
      }

      try {
        lastErrorRef.current = null;
        const localBuildStartedAt = new Date().toISOString();

        terminalRef.current?.clear();
        buildStream.disconnect();
        pendingLogsBuffer.current = [];
        // Reset the SSE dedup cursor. The new deployment emits a fresh event-id
        // sequence starting near 0; leaving the previous deploy's cursor here
        // makes the message processor drop the new stream's events (eventId <=
        // stale cursor) — logs freeze until a manual refresh resets it via
        // loadBuildSession. Clearing it makes the re-attach atomic.
        lastEventIdRef.current = undefined;
        if (!terminalRef.current) {
          isTerminalReady.current = false;
        }

        phaseStartRef.current = {};
        setState((prev) => ({
          ...prev,
          isDeploying: true,
          deploymentSuccess: false,
          deploymentFailed: false,
          deploymentCanceled: false,
          failureMessage: "",
          warningMessage: "",
          decisionPending: false,
          decisionFailedServiceIds: [],
          portCheck: [],
          portCheckSkipped: [],
          errorCode: "",
          errorDetails: null,
          pendingPrompt: null,
          currentStepIndex: 0,
          phaseDurations: {},
          buildLogs: [],
          screenshots: [],
          serviceStatuses: [],
          buildStartedAt: localBuildStartedAt,
          buildDurationMs: null,
          buildRetryCarryMs:
            prev.deploymentFailed || prev.deploymentCanceled ? resolveBuildElapsedMs(prev) : 0,
        }));

        const response = await deployApi.buildRedeploy(deploymentId);

        if (!response.success) {
          showToast(response.error || "Failed to redeploy", "error", "Error");
          setState((prev) => ({
            ...prev,
            isDeploying: false,
            deploymentFailed: true,
            failureMessage: response.error || "Failed to redeploy",
            warningMessage: "",
          }));
          return null;
        }

        const newDeploymentId = response.deployment_id || deploymentId;

        setState((prev) => ({
          ...prev,
          deploymentId: newDeploymentId,
        }));

        showToast("Redeployment started", "success", "Deploying");
        return newDeploymentId;
      } catch (error) {
        console.error("[DeploymentContext] Failed to redeploy:", error);
        const msg = getApiErrorMessage(error, "Failed to start redeployment");
        showToast(msg, "error", "Error");
        setState((prev) => ({
          ...prev,
          isDeploying: false,
          deploymentFailed: true,
          failureMessage: msg,
          warningMessage: "",
        }));
        return null;
      }
    },
    [buildStream, showToast],
  );

  const reset = useCallback(() => {
    lastErrorRef.current = null;
    phaseStartRef.current = {};
    setConfig(DEFAULT_CONFIG);
    setState(INITIAL_STATE);
    buildStream.disconnect();
    lastEventIdRef.current = undefined; // fresh dedup cursor for the next deploy
    isTerminalReady.current = false;
    pendingLogsBuffer.current = [];
    terminalRef.current?.clear();
  }, [buildStream, setConfig]);

  const onTerminalReady = useCallback(() => {
    isTerminalReady.current = true;
    flushPendingLogs();
  }, [flushPendingLogs]);

  const _setContainerFailed = useCallback((message: string) => {
    setState((prev) => ({
      ...prev,
      deploymentFailed: true,
      deploymentSuccess: false,
      failureMessage: message,
      warningMessage: "",
    }));
  }, []);

  const respondToPrompt = useCallback(async (action: string) => {
    if (!state.deploymentId) return;
    setState((prev) => ({ ...prev, pendingPrompt: null }));
    try {
      await deployApi.buildRespond(state.deploymentId, action);
    } catch (err) {
      console.error("[Deployment] Failed to respond to prompt:", err);
      showToast("Failed to respond to prompt", "error", "Error");
    }
  }, [state.deploymentId, showToast]);

  return {
    state,
    terminalRef,
    canStreamContainer,
    steps: STEPS,
    deploymentStatus,
    startDeployment,
    connectToBuild,
    loadBuildSession,
    stopDeployment,
    redeploy,
    reset,
    onTerminalReady,
    respondToPrompt,
    _setContainerFailed,
  };
}
