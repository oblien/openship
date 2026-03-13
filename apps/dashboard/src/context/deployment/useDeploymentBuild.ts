"use client";

import { useState, useRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { useToast } from "@/context/ToastContext";
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
    setState((prev) => ({
      ...prev,
      deploymentSuccess: true,
      currentProgress: 100,
      currentStepIndex: 4,
      isDeploying: false,
      screenshots: data?.screenshots || prev.screenshots,
      projectId: data?.project_id || prev.projectId,
    }));
  }, []);

  const handleFailureMessage = useCallback(
    (message?: string) => {
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
        canStreamContainer.current = true;
        buildStream.disconnect();
      },
      onFailure: (message) => {
        handleFailureMessage(message);
        buildStream.disconnect();
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

  const startDeployment = useCallback(async (): Promise<string | null> => {
    if (!config.repo || !config.owner || !config.branch) {
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
      screenshots: [],
    }));

    try {
      // Step 1: Ensure project exists
      const projectData = await projectsApi.ensure({
        name: config.projectName || config.repo,
        gitOwner: config.owner,
        gitRepo: config.repo,
        gitBranch: config.branch,
        framework: config.framework,
        packageManager: config.packageManager,
        buildImage: config.buildImage,
        buildCommand: config.options.buildCommand,
        outputDirectory: config.options.outputDirectory,
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
        branch: config.branch,
        envVars: Object.keys(envVarsMap).length > 0 ? envVarsMap : undefined,
        customDomain: config.domainType === "custom" && config.customDomain ? config.customDomain : undefined,
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
      showToast(extractErrorMessage(err, "Failed to start deployment"), "error", "Error");
      setState((prev) => ({ ...prev, isDeploying: false }));
      return null;
    }
  }, [config, showToast]);

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
          let cleanDomain = apiConfig.domain || "";
          if (cleanDomain.endsWith(".opsh.io")) {
            cleanDomain = cleanDomain.replace(".opsh.io", "");
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
            options: {
              buildCommand: apiConfig.buildCommand || prev.options.buildCommand,
              outputDirectory: apiConfig.outputDirectory || prev.options.outputDirectory,
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
          buildLogs,
        }));

        // Write existing logs to terminal
        if (buildLogs.length > 0) {
          const textEncoder = new TextEncoder();
          buildLogs.forEach((log) => writeToTerminal(textEncoder.encode(`${log.text}\r\n`)));
        }

        // Handle scenarios
        if (isActive) {
          await buildStream.connect(deploymentId, false);
        } else if (status === "ready") {
          handleSuccessMessage({ screenshots: data.screenshots, project_id: data.project_id });
          showToast("Build completed successfully", "success", "Success");
        } else if (status === "failed") {
          handleFailureMessage(data.failureMessage || "Build failed");
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
        handleCanceled(response.message);
      } else {
        showToast(response.error || "Failed to stop deployment", "error", "Error");
      }
    } catch (error) {
      console.error("[DeploymentContext] Error stopping deployment:", error);
      showToast(extractErrorMessage(error, "Failed to stop deployment"), "error", "Error");
    } finally {
      setState((prev) => ({ ...prev, isStopping: false }));
    }
  }, [state.deploymentId, state.isStopping, showToast, handleCanceled]);

  const redeploy = useCallback(
    async (deploymentId: string): Promise<string | null> => {
      if (!deploymentId) {
        showToast("Deployment ID not provided", "error", "Error");
        setState((prev) => ({
          ...prev,
          isDeploying: false,
          deploymentFailed: true,
          failureMessage: "Failed to start redeployment",
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
          buildLogs: [],
          currentProgress: 0,
          currentStepIndex: 0,
          screenshots: [],
        }));

        const response = await deployApi.buildRedeploy(deploymentId);

        if (!response.success) {
          showToast(response.error || "Failed to redeploy", "error", "Error");
          setState((prev) => ({
            ...prev,
            isDeploying: false,
            deploymentFailed: true,
            failureMessage: response.error || "Failed to redeploy",
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
    }));
  }, []);

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
    _setContainerFailed,
  };
}
