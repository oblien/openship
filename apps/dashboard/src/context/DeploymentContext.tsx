"use client";

import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from "react";
import type { Terminal } from "@xterm/xterm";
import { useToast } from "@/context/ToastContext";
import { BuildLog } from "@/utils/deploymentPhaseDetector";
import { useBuildStream } from "@/hooks/useSSEConnection";
import { FrameworkId, EnvironmentVariable } from "@/components/import-project/types";
import { deployApi } from "@/lib/api";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";

interface Screenshot {
  url: string;
  variants: Array<{
    variant: string;
    url: string;
  }>;
  size: number;
  mime: string;
}

interface DeploymentConfig {
  projectName: string;
  repo: string;
  owner: string;
  framework: FrameworkId;
  domain: string;
  customDomain: string;
  domainType: "free" | "custom";
  envVars: EnvironmentVariable[];
  branch: string;
  branches: string[]; // Available branches
  options: {
    buildCommand: string;
    outputDirectory: string;
    installCommand: string;
    startCommand: string;
    productionPort: string;
    rootDirectory: string;
    hasServer: boolean;
  };
}

interface DeploymentState {
  deployment_session_id: string | null;
  buildToken: string | null;
  isDeploying: boolean;
  isStopping: boolean;
  deploymentSuccess: boolean;
  deploymentFailed: boolean;
  deploymentCanceled: boolean;
  failureMessage: string;
  buildLogs: BuildLog[];
  currentProgress: number;
  currentStepIndex: number;
  screenshots: Screenshot[];
  projectId: string | null;
}

type DeploymentStatus = "building" | "deploying" | "ready" | "failed" | "cancelled";

interface DeploymentContextType {
  // Single source of truth
  config: DeploymentConfig;
  state: DeploymentState;
  terminalRef: React.MutableRefObject<Terminal | null>;
  canStreamContainer: React.MutableRefObject<boolean>;
  // Config updates (user input or server data)
  updateConfig: (updates: Partial<DeploymentConfig>) => void;
  updateOptions: (updates: Partial<DeploymentConfig['options']>) => void;

  // Deployment lifecycle
  initializeFromRepo: (owner: string, repo: string, force?: string) => Promise<{ success: boolean; error?: string; errorType?: string; buildInProgress?: boolean }>;
  startDeployment: () => Promise<string | null>;
  connectToBuild: () => Promise<void>; // NEW: Connect to build stream (called by build page)
  loadBuildSession: (deployment_session_id: string) => Promise<{ success: boolean; error?: string }>;
  stopDeployment: () => Promise<void>;
  redeploy: (deployment_session_id: string) => Promise<string | null>;
  reset: () => void;

  // Terminal lifecycle
  onTerminalReady: () => void;

  // Internal state updates (don't expose these to pages)
  _setContainerFailed: (message: string) => void;
  steps: any[];
  deploymentStatus: DeploymentStatus;
}

const DeploymentContext = createContext<DeploymentContextType | undefined>(undefined);

export const useDeployment = () => {
  const context = useContext(DeploymentContext);
  if (!context) {
    throw new Error("useDeployment must be used within DeploymentProvider");
  }
  return context;
};

const DEFAULT_CONFIG: DeploymentConfig = {
  projectName: "",
  repo: "",
  owner: "",
  framework: "next",
  domain: "",
  customDomain: "",
  domainType: "free",
  branch: "main",
  branches: [],
  options: {
    buildCommand: "bun build",
    outputDirectory: ".next",
    installCommand: "bun install",
    startCommand: "bunstart",
    productionPort: "3000",
    rootDirectory: "./",
    hasServer: true,
  },
  envVars: [],
};

const INITIAL_STATE: DeploymentState = {
  deployment_session_id: null,
  buildToken: null,
  isDeploying: false,
  isStopping: false,
  deploymentSuccess: false,
  deploymentFailed: false,
  deploymentCanceled: false,
  failureMessage: "",
  buildLogs: [],
  currentProgress: 0,
  currentStepIndex: 0,
  screenshots: [],
  projectId: null,
};

export const DeploymentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { showToast } = useToast();

  // Single source of truth
  const [config, setConfig] = useState<DeploymentConfig>(DEFAULT_CONFIG);
  const [state, setState] = useState<DeploymentState>(INITIAL_STATE);

  // Refs for terminal and connections
  const terminalRef = useRef<Terminal | null>(null);
  const pendingLogsBuffer = useRef<Uint8Array[]>([]); // Store binary data for proper terminal rendering
  const isTerminalReady = useRef<boolean>(false);
  const hasInitializedRef = useRef<boolean>(false);
  const canStreamContainer = useRef<boolean>(false);
  const lastEventIdRef = useRef<number | undefined>(undefined);

  // Error deduplication tracking
  const lastErrorRef = useRef<{ message: string; timestamp: number } | null>(null);
  const ERROR_DEBOUNCE_MS = 1000; // Ignore duplicate errors within 1 second

  // ============================================================================
  // CONFIG MANAGEMENT - Single source of truth for all deployment configuration
  // ============================================================================

  const steps = [
    { label: "Cloning", icon: 'git%20branch-159-1658431404.png' },
    { label: "Installing", icon: 'npm-184-1693375161.png' },
    { label: "Building", icon: 'tools-118-1658432731.png' },
    { label: "Deploying", icon: 'space%20rocket-85-1687505546.png' },
    { label: "Ready", icon: 'check%20circle-68-1658234612.png' },
  ];

  // Determine deployment status based on flags
  const deploymentStatus: DeploymentStatus =
    state.deploymentCanceled ? "cancelled" :
      state.deploymentFailed ? "failed" :
        state.deploymentSuccess ? "ready" :
          state.currentStepIndex >= 3 ? "deploying" :
            "building";

  const updateConfig = useCallback((updates: Partial<DeploymentConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  }, []);

  const updateOptions = useCallback((updates: Partial<DeploymentConfig['options']>) => {
    setConfig((prev) => ({ ...prev, options: { ...prev.options, ...updates } }));
  }, []);

  // Initialize config from repository (called by deploy page)
  const initializeFromRepo = useCallback(async (owner: string, repo: string, force?: string): Promise<{ success: boolean; error?: string; errorType?: string; buildInProgress?: boolean }> => {
    try {
      const response = await deployApi.init({ owner, repo, force });

      if (response?.error) {
        return {
          success: false,
          error: response.error,
          errorType: 'api_error'
        };
      }

      // Check if build already in progress
      if (response?.current_status === 'running' || response?.exists) {
        return { success: false, buildInProgress: true };
      }

      const repoName = response.repository.name || repo;
      const detectedFramework = response.stack || "next";

      // Get framework configuration for the detected framework
      const frameworkConfig = getFrameworkConfig(detectedFramework as FrameworkId);

      // Update config with server data including framework defaults
      setConfig((prev) => ({
        ...prev,
        repo: repoName,
        owner: response.repository.owner?.login || owner,
        projectName: repoName,
        domain: repoName.toLowerCase(),
        framework: detectedFramework as FrameworkId,
        branch: response.repository.default_branch || "main",
        branches: response.repository.branches?.map((b: any) => b.name) || [],
        options: {
          buildCommand: frameworkConfig.options.buildCommand,
          installCommand: frameworkConfig.options.installCommand,
          outputDirectory: frameworkConfig.options.outputDirectory,
          startCommand: "npm start",
          productionPort: "3000",
          rootDirectory: "./",
          hasServer: !frameworkConfig.options.isStatic,
        },
      }));

      return { success: true };
    } catch (err) {
      console.error("Error initializing from repo:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch repository data";
      return {
        success: false,
        error: errorMessage,
        errorType: 'network_error'
      };
    }
  }, [showToast]);

  // ============================================================================
  // INTERNAL HANDLERS - Called by SSE stream
  // ============================================================================

  const writeToTerminal = useCallback((data: Uint8Array) => {
    if (terminalRef.current && isTerminalReady.current) {
      terminalRef.current.write(data);
    } else {
      // Buffer binary data for later
      console.log('[DeploymentContext] Terminal not ready, buffering log chunk');
      pendingLogsBuffer.current.push(data);
    }
  }, []);

  const flushPendingLogs = useCallback(() => {
    if (terminalRef.current && pendingLogsBuffer.current.length > 0) {
      console.log(`[DeploymentContext] Flushing ${pendingLogsBuffer.current.length} buffered log chunks`);
      pendingLogsBuffer.current.forEach(data => terminalRef.current?.write(data));
      pendingLogsBuffer.current = [];
    }
  }, []);

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

  const handleFailureMessage = useCallback((message?: string) => {
    const errorMessage = message || "Build failed. Check logs for details.";
    const now = Date.now();

    // Check for duplicate error within debounce window
    if (lastErrorRef.current) {
      const timeSinceLastError = now - lastErrorRef.current.timestamp;
      const isSameError = lastErrorRef.current.message === errorMessage;

      if (isSameError && timeSinceLastError < ERROR_DEBOUNCE_MS) {
        console.log('[DeploymentContext] Ignoring duplicate error:', errorMessage);
        return; // Skip duplicate error
      }
    }

    // Track this error
    lastErrorRef.current = { message: errorMessage, timestamp: now };

    console.log('[DeploymentContext] Handling failure:', errorMessage);

    setState((prev) => ({
      ...prev,
      deploymentFailed: true,
      deploymentSuccess: false,
      isDeploying: false,
      failureMessage: errorMessage,
    }));

    const textEncoder = new TextEncoder();
    const errorBytes = textEncoder.encode(`\r\n\x1b[31m Deployment Failed: ${errorMessage}\x1b[0m\r\n`);
    writeToTerminal(errorBytes);
    showToast(errorMessage, 'error', 'Deployment Failed');
  }, [showToast, writeToTerminal]);

  const handleProgressUpdate = useCallback((currentStep: number, progress: number) => {
    setState((prev) => ({
      ...prev,
      currentStepIndex: currentStep,
      currentProgress: progress,
    }));
  }, []);

  const handleCanceled = useCallback((message?: string) => {
    const cancelMessage = message || 'Deployment cancelled by user';
    const now = Date.now();

    // Check for duplicate cancel message
    if (lastErrorRef.current) {
      const timeSinceLastError = now - lastErrorRef.current.timestamp;
      const isSameMessage = lastErrorRef.current.message === cancelMessage;

      if (isSameMessage && timeSinceLastError < ERROR_DEBOUNCE_MS) {
        console.log('[DeploymentContext] Ignoring duplicate cancel:', cancelMessage);
        return;
      }
    }

    // Track this cancel
    lastErrorRef.current = { message: cancelMessage, timestamp: now };

    console.log('[DeploymentContext] Handling cancellation:', cancelMessage);

    setState((prev) => ({
      ...prev,
      deploymentCanceled: true,
      deploymentFailed: false,
      deploymentSuccess: false,
      isDeploying: false,
      isStopping: false,
      failureMessage: cancelMessage,
    }));
  }, []);

  // ============================================================================
  // BUILD STREAM SETUP - Using clean architecture!
  // ============================================================================

  const buildStream = useBuildStream({
    terminalRef,
    autoWriteToTerminal: false, // Disable auto-write, we'll handle buffering
    callbacks: {
      onLog: (message, rawText, rawBytes) => {
        // Track event ID for reconnection
        if (message.eventId !== undefined) {
          lastEventIdRef.current = message.eventId;
        }

        // Buffer log data if we have raw bytes
        if (rawBytes) {
          writeToTerminal(rawBytes);
        }
      },
      onPhaseChange: (phase) => {
        console.log('[Deployment] Build phase:', phase);
      },
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
        showToast(message || 'Deployment cancelled', 'success', 'Cancelled');
      },
      onReconnected: () => {
        showToast('Reconnected successfully', 'success', 'Connected');
      },
    },
    onConnect: () => console.log('[Deployment] Build connection established'),
    onDisconnect: () => console.log('[Deployment] Build connection ended'),
    onError: (error) => console.error('[Deployment] Build connection error:', error),
  });

  // ============================================================================
  // DEPLOYMENT LIFECYCLE
  // ============================================================================

  const startDeployment = useCallback(async (): Promise<string | null> => {
    // Validate config
    if (!config.repo || !config.owner || !config.branch) {
      showToast("Repository data is incomplete", "error", "Error");
      return null;
    }

    if (!config.framework || config.framework === "unknown") {
      showToast("Please select a framework", "error", "Error");
      return null;
    }

    // Clear error tracking for new deployment
    lastErrorRef.current = null;
    console.log('[DeploymentContext] Starting new deployment, cleared error tracking');

    // Reset state for new deployment
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
      // Build final domain - always use the free domain format for the domain field
      const baseDomain = config.domain || config.projectName;
      const freeDomain = baseDomain.endsWith('.obl.ee') ? baseDomain : `${baseDomain}.obl.ee`;

      const payload = {
        repo: config.repo,
        owner: config.owner,
        stack: config.framework,
        domain: freeDomain, // Always send the free domain in the domain field
        payload: config.envVars,
        name: config.projectName,
        branch: config.branch,
        options: config.options,
        ...(config.domainType === "custom" && { customDomain: config.customDomain }),
      };

      const data = await deployApi.buildAccess(payload);

      if (data.success && data.deployment_session_id) {
        setState((prev) => ({
          ...prev,
          deployment_session_id: data.deployment_session_id,
          projectId: data.project_id || prev.projectId,
          buildToken: data.token,
        }));

        // DON'T connect here - let build page connect for instant navigation!
        // Build page will call connectToBuild() when it mounts

        return data.deployment_session_id;
      } else {
        showToast(data.message || "Deployment failed", "error", "Error");
        setState((prev) => ({ ...prev, isDeploying: false }));
        return null;
      }
    } catch (err) {
      console.error("Deployment error:", err);
      showToast("Failed to start deployment", "error", "Error");
      setState((prev) => ({ ...prev, isDeploying: false }));
      return null;
    }
  }, [config, showToast]);

  /**
   * Connect to build stream using stored token
   * Called by build page when it mounts with a fresh deployment
   */
  const connectToBuild = useCallback(async () => {
    if (!state.buildToken) {
      throw new Error('No build token available');
    }

    await buildStream.connect(state.buildToken, true); // true = start new build
  }, [state.buildToken, buildStream]);

  const loadBuildSession = useCallback(async (deployment_session_id: string): Promise<{ success: boolean; error?: string }> => {
    try {
      // Clear error tracking when loading a session
      lastErrorRef.current = null;
      console.log('[DeploymentContext] Loading build session, cleared error tracking');

      const data = await deployApi.getBuildStatus(deployment_session_id);

      if (!data.success) {
        const errorMessage = data.error || "Failed to load build session";
        showToast(errorMessage, "error", "Error");
        return { success: false, error: errorMessage };
      }

      // Transform flat config from API to nested structure
      if (data.config) {
        const apiConfig = data.config;

        // Extract domain without .obl.ee suffix for editing
        let cleanDomain = apiConfig.domain || "";
        if (cleanDomain.endsWith('.obl.ee')) {
          cleanDomain = cleanDomain.replace('.obl.ee', '');
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
          },
        }));
      }

      // Parse existing logs
      const buildLogs: BuildLog[] = data.logs
        ? data.logs.split('\n')
          .filter((line: string) => line.trim())
          .map((line: string) => ({
            type: 'info' as const,
            text: line,
            time: new Date().toISOString()
          }))
        : [];

      // Determine status
      const isActive = data.is_active;
      const status = data.status; // 'building' | 'success' | 'failed' | 'cancelled'

      // Update state with session data
      setState((prev) => ({
        ...prev,
        deployment_session_id,
        projectId: data.project_id || prev.projectId,
        buildToken: data.token || prev.buildToken,
        currentProgress: data.progress || 0,
        currentStepIndex: data.currentStep || 0,
        // For completed builds, set final states; for active builds, SSE will update these
        deploymentSuccess: !isActive && status === 'success',
        deploymentFailed: !isActive && status === 'failed',
        deploymentCanceled: !isActive && status === 'cancelled',
        isDeploying: isActive,
        // Only set screenshots/failures if build is complete - otherwise SSE will provide them
        screenshots: !isActive ? (data.screenshots || []) : [],
        failureMessage: !isActive ? (data.failureMessage || "") : "",
        buildLogs,
      }));

      // Write existing logs to terminal
      if (buildLogs.length > 0) {
        console.log(`[DeploymentContext] Writing ${buildLogs.length} existing logs to terminal`);
        buildLogs.forEach(log => {
          const textEncoder = new TextEncoder();
          const bytes = textEncoder.encode(`${log.text}\r\n`);
          writeToTerminal(bytes);
        });
      }

      // Handle different scenarios
      if (isActive && data.token) {
        // Build is still running - connect to SSE stream (will handle completion)
        await buildStream.connect(data.token, false); // false = attach to existing build
        showToast('Reconnected to build', 'success', 'Connected');
      } else {
        // Build is complete - trigger appropriate handlers
        if (status === 'success') {
          // Trigger success handler to enable container streaming and process screenshots
          handleSuccessMessage({
            screenshots: data.screenshots,
            project_id: data.project_id
          });
          showToast('Build completed successfully', 'success', 'Success');
        } else if (status === 'failed') {
          handleFailureMessage(data.failureMessage || 'Build failed');
        } else if (status === 'cancelled') {
          handleCanceled(data.failureMessage || 'Build was cancelled');
        }
      }

      return { success: true };
    } catch (err) {
      console.error("Error loading build session:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to load build session";
      showToast(errorMessage, "error", "Error");
      return { success: false, error: errorMessage };
    }
  }, [buildStream, showToast, writeToTerminal, handleSuccessMessage, handleFailureMessage, handleCanceled]);

  const stopDeployment = useCallback(async () => {
    if (state.isStopping || !state.deployment_session_id) {
      return;
    }

    setState((prev) => ({ ...prev, isStopping: true }));

    try {
      const response = await deployApi.buildCancel(state.deployment_session_id);

      if (response.success) {
        handleCanceled(response.message);
      } else {
        showToast(response.error || 'Failed to stop deployment', 'error', 'Error');
      }
    } catch (error) {
      console.error('[DeploymentContext] Error stopping deployment:', error);
      showToast('Failed to stop deployment', 'error', 'Error');
    } finally {
      setState((prev) => ({ ...prev, isStopping: false }));
    }
  }, [state.deployment_session_id, state.isStopping, showToast, handleCanceled]);

  const redeploy = useCallback(async (deployment_session_id: string): Promise<string | null> => {

    if (!deployment_session_id) {
      showToast('Deployment session doesn\'t passed', 'error', 'Error');
      setState((prev) => ({
        ...prev,
        isDeploying: false,
        deploymentFailed: true,
        failureMessage: 'Failed to start redeployment'
      }));
      return null;
    }

    try {
      // Clear error tracking for redeploy
      lastErrorRef.current = null;
      console.log('[DeploymentContext] Starting redeploy, cleared error tracking');

      // Clear terminal and reset state
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

      const response = await deployApi.buildRedeploy(deployment_session_id);

      if (!response.success) {
        showToast(response.error || 'Failed to redeploy', 'error', 'Error');
        setState((prev) => ({
          ...prev,
          isDeploying: false,
          deploymentFailed: true,
          failureMessage: response.error || 'Failed to redeploy'
        }));
        return null;
      }

      const newDeploymentSessionId = response.deployment_session_id || deployment_session_id;

      setState((prev) => ({
        ...prev,
        deployment_session_id: newDeploymentSessionId,
        buildToken: response.token || prev.buildToken,
      }));

      // DON'T connect here - build page will call connectToBuild() after URL update
      showToast('Redeployment started', 'success', 'Deploying');

      // Return new session ID so caller can update URL and trigger connection
      return newDeploymentSessionId;

    } catch (error) {
      console.error('[DeploymentContext] Failed to redeploy:', error);
      showToast('Failed to start redeployment', 'error', 'Error');
      setState((prev) => ({
        ...prev,
        isDeploying: false,
        deploymentFailed: true,
        failureMessage: 'Failed to start redeployment'
      }));
      return null;
    }
  }, [state.deployment_session_id, buildStream, showToast]);

  const reset = useCallback(() => {
    // Clear error tracking on reset
    lastErrorRef.current = null;
    console.log('[DeploymentContext] Reset called, cleared error tracking');

    setConfig(DEFAULT_CONFIG);
    setState(INITIAL_STATE);
    buildStream.disconnect();
    isTerminalReady.current = false;
    pendingLogsBuffer.current = [];
    terminalRef.current?.clear();
  }, [buildStream]);

  const onTerminalReady = useCallback(() => {
    console.log('[DeploymentContext] Terminal ready, flushing pending logs');
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

  // ============================================================================
  // PROVIDER VALUE
  // ============================================================================

  const value: DeploymentContextType = {
    config,
    state,
    terminalRef,
    canStreamContainer,
    updateConfig,
    updateOptions,
    initializeFromRepo,
    startDeployment,
    connectToBuild,
    loadBuildSession,
    stopDeployment,
    redeploy,
    reset,
    onTerminalReady,
    steps,
    deploymentStatus,
    _setContainerFailed,
  };

  return (
    <DeploymentContext.Provider value={value}>
      {children}
    </DeploymentContext.Provider>
  );
};

