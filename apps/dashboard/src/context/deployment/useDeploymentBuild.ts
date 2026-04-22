"use client";

import { useState, useRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { useToast } from "@/context/ToastContext";
import { useCloud } from "@/context/CloudContext";
import { usePlatform } from "@/context/PlatformContext";
import type { BuildLog } from "@/utils/deploymentPhaseDetector";
import { useBuildStream } from "@/hooks/useSSEConnection";
import { deployApi, projectsApi } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import type { DeploymentConfig, DeploymentState, DeploymentStatus } from "./types";
import { DEFAULT_CONFIG, INITIAL_STATE } from "./types";

const ERROR_DEBOUNCE_MS = 1000;

/** Extract a human-readable message from API errors. */
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const body = err.body as Record<string, unknown> | undefined;
    if (body && typeof body.message === "string") return body.message;
    if (body && typeof body.error === "string") return body.error;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

function extractErrorCode(err: unknown): string | null {
  if (err instanceof ApiError) {
    const body = err.body as Record<string, unknown> | undefined;
    if (body && typeof body.code === "string") return body.code;
  }
  return null;
}

const STEPS = [
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
  const [state, setState] = useState<DeploymentState>(INITIAL_STATE);

  // ── Refs ──────────────────────────────────────────────────────────────────

  const terminalRef = useRef<Terminal | null>(null);
  const pendingLogsBuffer = useRef<Uint8Array[]>([]);
  const isTerminalReady = useRef<boolean>(false);
  const canStreamContainer = useRef<boolean>(false);
  const lastEventIdRef = useRef<number | undefined>(undefined);
  const lastErrorRef = useRef<{ message: string; timestamp: number } | null>(null);

  // ── Derived ───────────────────────────────────────────────────────────────

  const deploymentStatus: DeploymentStatus = state.deploymentCanceled
    ? "cancelled"
    : state.deploymentFailed
      ? "failed"
      : state.deploymentSuccess
        ? "ready"
        : state.currentStepIndex >= 3
          ? "deploying"
          : "building";

  // ── Terminal helpers ──────────────────────────────────────────────────────

  const writeToTerminal = useCallback((data: Uint8Array) => {
    if (terminalRef.current && isTerminalReady.current) {
      terminalRef.current.write(data);
    } else {
      pendingLogsBuffer.current.push(data);
    }
  }, []);

  const flushPendingLogs = useCallback(() => {
    if (terminalRef.current && pendingLogsBuffer.current.length > 0) {
      pendingLogsBuffer.current.forEach((data) => terminalRef.current?.write(data));
      pendingLogsBuffer.current = [];
    }
  }, []);

  // ── Stream event handlers ─────────────────────────────────────────────────

  const handleSuccessMessage = useCallback((data?: any) => {
    const warningMessage = typeof data?.warningMessage === "string" ? data.warningMessage : "";

    setState((prev) => ({
      ...prev,
      deploymentSuccess: true,
      deploymentFailed: false,
      deploymentCanceled: false,
      currentProgress: 100,
      currentStepIndex: 4,
      isDeploying: false,
      failureMessage: "",
      warningMessage,
      screenshots: data?.screenshots || prev.screenshots,
      projectId: data?.project_id || prev.projectId,
    }));

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
    setState((prev) => ({
      ...prev,
      currentStepIndex: currentStep,
      currentProgress: progress,
    }));
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
      onLog: (message, _rawText, rawBytes) => {
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
    overrides?: { runtimeMode?: DeploymentConfig["runtimeMode"] },
  ): Promise<string | null> => {
    const isLocal = !!config.localPath;
    if (!isLocal && (!config.repo || !config.owner || !config.branch)) {
      showToast("Repository data is incomplete", "error", "Error");
      return null;
    }

    if (!config.framework || config.framework === "unknown") {
      showToast("Please select a framework", "error", "Error");
      return null;
    }

    lastErrorRef.current = null;

    setState((prev) => ({
      ...prev,
      isDeploying: true,
      isStopping: false,
      buildLogs: [],
      currentProgress: 0,
      currentStepIndex: 0,
      deploymentSuccess: false,
      deploymentFailed: false,
      deploymentCanceled: false,
      failureMessage: "",
      warningMessage: "",
      errorCode: "",
      errorDetails: null,
      pendingPrompt: null,
      screenshots: [],
      serviceStatuses: [],
    }));

    try {
      // Step 1: Ensure project exists
      const projectData = await projectsApi.ensure({
        name: config.projectName || config.repo || config.localPath?.split("/").pop() || "project",
        gitOwner: isLocal ? undefined : config.owner || undefined,
        gitRepo: isLocal ? undefined : config.repo || undefined,
        gitBranch: isLocal ? undefined : config.branch || undefined,
        localPath: config.localPath || undefined,
        framework: config.framework,
        packageManager: config.packageManager,
        buildImage: config.buildImage,
        buildCommand: config.options.buildCommand,
        outputDirectory: config.options.outputDirectory,
        productionPaths: config.options.productionPaths || undefined,
        installCommand: config.options.installCommand,
        startCommand: config.options.startCommand,
        rootDirectory: config.options.rootDirectory,
        port: config.options.productionPort ? Number(config.options.productionPort) : undefined,
        hasServer: config.options.hasServer,
        hasBuild: config.options.hasBuild,
        slug: config.domain || undefined,
      });

      if (!projectData.success || !projectData.project_id) {
        showToast(projectData.error || "Failed to create project", "error", "Error");
        setState((prev) => ({ ...prev, isDeploying: false }));
        return null;
      }

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
        envVars: Object.keys(envVarsMap).length > 0 ? envVarsMap : undefined,
        customDomain: config.domainType === "custom" && config.customDomain
          ? config.customDomain
          : undefined,
        buildStrategy: config.projectType === "app" ? config.buildStrategy : "server",
        deployTarget: config.deployTarget,
        serverId: config.serverId,
        runtimeMode:
          config.projectType === "docker" || config.projectType === "services"
            ? "docker"
            : (overrides?.runtimeMode ?? config.runtimeMode),
        services: config.projectType === "services"
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
      const message = extractErrorMessage(err, "Failed to start deployment");
      const errorCode = extractErrorCode(err);
      const canUseCloudConnection = selfHosted || deployMode === "desktop";
      const needsManagedProjectDomainHelp =
        canUseCloudConnection &&
        config.projectType !== "services" &&
        config.deployTarget !== "cloud" &&
        config.domainType === "free" &&
        errorCode === "CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN";
      const needsManagedComposeDomainHelp =
        canUseCloudConnection &&
        config.projectType === "services" &&
        errorCode === "CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS";
      const needsCloudTargetHelp = errorCode === "CLOUD_REQUIRED_TARGET";

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
      } else {
        showToast(message, "error", "Error");
      }
      setState((prev) => ({ ...prev, isDeploying: false }));
      return null;
    }
  }, [baseDomain, config, deployMode, requireCloud, selfHosted, showToast]);

  const connectToBuild = useCallback(async (deploymentId?: string) => {
    const id = deploymentId || state.deploymentId;
    if (!id) {
      throw new Error("No deployment ID available");
    }
    await buildStream.connect(id, true);
  }, [state.deploymentId, buildStream]);

  const loadBuildSession = useCallback(
    async (deploymentId: string): Promise<{ success: boolean; error?: string }> => {
      try {
        lastErrorRef.current = null;

        // Reset state immediately to avoid flashing stale data from previous deployment
        setState((prev) => ({
          ...INITIAL_STATE,
          deploymentId,
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
          // Strip domain suffix (e.g. "myapp.opsh.io" → "myapp", "myapp.example.com" → "myapp")
          let cleanDomain = apiConfig.domain || "";
          const dotIdx = cleanDomain.indexOf(".");
          if (dotIdx > 0) {
            cleanDomain = cleanDomain.slice(0, dotIdx);
          }

          setConfig((prev) => ({
            ...prev,
            domain: cleanDomain,
            domainType: apiConfig.domainType || "free",
            customDomain: apiConfig.customDomain || "",
            repo: apiConfig.repo || prev.repo,
            owner: apiConfig.owner || prev.owner,
            projectName: apiConfig.projectName || prev.projectName,
            framework: apiConfig.framework || prev.framework,
            branch: apiConfig.branch || prev.branch,
            envVars: apiConfig.envVars || prev.envVars,
            projectType: data.projectType || prev.projectType,
            options: {
              buildCommand: apiConfig.buildCommand || prev.options.buildCommand,
              outputDirectory: apiConfig.outputDirectory || prev.options.outputDirectory,
              productionPaths: apiConfig.productionPaths || prev.options.productionPaths,
              installCommand: apiConfig.installCommand || prev.options.installCommand,
              startCommand: apiConfig.startCommand || prev.options.startCommand,
              productionPort: apiConfig.productionPort || prev.options.productionPort,
              rootDirectory: apiConfig.rootDirectory || prev.options.rootDirectory,
              hasServer: apiConfig.hasServer !== undefined ? apiConfig.hasServer : prev.options.hasServer,
              hasBuild: apiConfig.hasBuild !== undefined ? apiConfig.hasBuild : prev.options.hasBuild,
            },
          }));
        }

        // Parse existing logs
        const buildLogs: BuildLog[] = data.logs
          ? data.logs
              .split("\n")
              .filter((line: string) => line.trim())
              .map((line: string) => ({ type: "info" as const, text: line, time: new Date().toISOString() }))
          : [];

        const isActive = data.is_active;
        const status = data.status;

        setState((prev) => ({
          ...prev,
          deploymentId,
          projectId: data.project_id || prev.projectId,
          currentProgress: data.progress || 0,
          currentStepIndex: data.currentStep || 0,
          deploymentSuccess: !isActive && status === "ready",
          deploymentFailed: !isActive && status === "failed",
          deploymentCanceled: !isActive && status === "cancelled",
          isDeploying: isActive,
          screenshots: !isActive ? (data.screenshots || []) : [],
          failureMessage: !isActive ? (data.failureMessage || "") : "",
          warningMessage: !isActive ? (data.warningMessage || "") : "",
          errorCode: !isActive ? (data.errorCode || "") : "",
          errorDetails: null,
          buildLogs,
          buildDurationMs: data.buildDurationMs ?? null,
          buildStartedAt: data.buildStartedAt ?? null,
          // Restore per-service statuses for compose projects
          serviceStatuses: data.projectType === "services" && data.services && data.serviceStatuses
            ? (data.services as any[]).map((svc: any) => {
                const sd = (data.serviceStatuses as any[]).find((s: any) => s.serviceId === svc.serviceId);
                const rawStatus = sd?.status ?? "pending";
                // Map DB statuses to UI statuses (DB may store "running", "failed", "pending", "deploying", "building", "stopped")
                const status: import("./types").ServiceDeployStatus["status"] =
                  rawStatus === "running" ? "running"
                  : rawStatus === "failed" ? "failed"
                  : rawStatus === "deploying" || rawStatus === "building" ? "deploying"
                  : "pending";
                return {
                  serviceId: svc.serviceId,
                  serviceName: svc.serviceName,
                  status,
                  containerId: sd?.containerId,
                  hostPort: sd?.hostPort,
                  image: svc.image,
                  build: svc.build,
                } as import("./types").ServiceDeployStatus;
              })
            : [],
        }));

        // Hydrate current terminal output before subscribing.
        // For active sessions, track the last replayed event ID so SSE
        // replay does not duplicate logs after refresh.
        if (buildLogs.length > 0) {
          if (isActive && typeof data.lastEventId === "number") {
            lastEventIdRef.current = data.lastEventId;
          }
          const textEncoder = new TextEncoder();
          buildLogs.forEach((log) => writeToTerminal(textEncoder.encode(`${log.text}\r\n`)));
        }

        // Handle scenarios
        if (isActive) {
          await buildStream.connect(deploymentId, false);
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
        const errorMessage = extractErrorMessage(err, "Failed to load build session");
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
      showToast(extractErrorMessage(error, "Failed to stop deployment"), "error", "Error");
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

        terminalRef.current?.clear();
        buildStream.disconnect();
        isTerminalReady.current = false;
        pendingLogsBuffer.current = [];

        setState((prev) => ({
          ...prev,
          isDeploying: true,
          deploymentSuccess: false,
          deploymentFailed: false,
          deploymentCanceled: false,
          failureMessage: "",
          warningMessage: "",
          errorCode: "",
          errorDetails: null,
          pendingPrompt: null,
          currentStepIndex: 0,
          screenshots: [],
          serviceStatuses: [],
          buildStartedAt: null,
          buildDurationMs: null,
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
        const msg = extractErrorMessage(error, "Failed to start redeployment");
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
    setConfig(DEFAULT_CONFIG);
    setState(INITIAL_STATE);
    buildStream.disconnect();
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
