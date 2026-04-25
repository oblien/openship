/**
 * High-level SSE Connection Hooks
 * 
 * These hooks provide complete SSE streaming solutions:
 * - Connection management (auth, tokens, URLs)
 * - Message processing
 * - State management
 * 
 * Clean entry points - no need to call connection helpers directly!
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SSEMessage, useSSEStream } from './useSSEStream';
import { createLogMessageProcessor, createBuildMessageProcessor, LogMessageCallbacks, BuildMessageCallbacks } from '@/lib/sseMessageProcessors';
import { getApiBaseUrl } from '@/lib/api';
import type { Terminal } from '@xterm/xterm';

const BUILD_RECONNECT_BASE_DELAY_MS = 1000;
const BUILD_RECONNECT_MAX_DELAY_MS = 15000;
const BUILD_STREAM_IDLE_TIMEOUT_MS = 60000;

// ============================================================================
// LIVE LOGS CONNECTION HOOK
// ============================================================================

export interface UseLogStreamOptions {
  // Terminal integration (optional)
  terminalRef?: React.MutableRefObject<Terminal | null>;
  autoWriteToTerminal?: boolean;
  
  // Callbacks
  callbacks?: LogMessageCallbacks;
  
  // Lifecycle
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

export interface UseLogStreamReturn {
  connect: (target: string) => Promise<void>;
  disconnect: () => void;
  isConnected: boolean;
  isConnecting: boolean;
  error: Error | null;
}

/**
 * Hook for live container/server logs
 * 
 * Usage:
 * ```tsx
 * const logs = useLogStream({
 *   terminalRef,
 *   callbacks: {
 *     onLog: (message, text) => console.log(text),
 *     onError: (msg) => showToast(msg, 'error'),
 *   },
 * });
 * 
 * // Connect
 * logs.connect(projectId);
 * 
 * // Disconnect
 * logs.disconnect();
 * ```
 */
export const useLogStream = (options: UseLogStreamOptions = {}): UseLogStreamReturn => {
  const {
    terminalRef,
    autoWriteToTerminal = true,
    callbacks = {},
    onConnect,
    onDisconnect,
    onError,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const callbacksRef = useRef(callbacks);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    callbacksRef.current = callbacks;
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
    onErrorRef.current = onError;
  }, [callbacks, onConnect, onDisconnect, onError]);

  // Create message processor
  const messageProcessor = useMemo(() => createLogMessageProcessor({
    onLog: (message, rawText, rawBytes) => {
      callbacksRef.current.onLog?.(message, rawText, rawBytes);
    },
    onError: (message) => {
      callbacksRef.current.onError?.(message);
    },
    onContainerExit: (exitCode, message) => {
      callbacksRef.current.onContainerExit?.(exitCode, message);
    },
  }), []);

  const handleConnect = useCallback(() => {
    setIsConnected(true);
    setIsConnecting(false);
    setError(null);
    onConnectRef.current?.();
  }, []);

  const handleDisconnect = useCallback(() => {
    setIsConnected(false);
    setIsConnecting(false);
    onDisconnectRef.current?.();
  }, []);

  const handleError = useCallback((err: Error) => {
    setError(err);
    setIsConnected(false);
    setIsConnecting(false);
    onErrorRef.current?.(err);
  }, []);

  // Initialize SSE stream
  const sseStream = useSSEStream({
    terminalRef,
    autoWriteToTerminal,
    messageProcessor,
    onConnect: handleConnect,
    onDisconnect: handleDisconnect,
    onError: handleError,
  });

  /**
   * Connect to live logs stream
   */

  const isConnectingRef = useRef(false);
  const connect = useCallback(async (target: string) => {
    try {
      if (isConnectingRef.current) return;
      setIsConnecting(true);
      isConnectingRef.current = true;
      setError(null);

      // Create abort controller
      abortControllerRef.current = new AbortController();

      // Connect to runtime logs stream via local API
      const baseUrl = getApiBaseUrl();
      const url = /^https?:\/\//.test(target)
        ? target
        : target.includes("/")
          ? `${baseUrl}${target}`
          : `${baseUrl}projects/${target}/logs/stream`;
      
      await sseStream.connect(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
        },
      });
    } catch (err: any) {
      console.error('[useLogStream] Connection error:', err);
      setError(err);
      onErrorRef.current?.(err);
      throw err;
    } finally {
      isConnectingRef.current = false;
      setIsConnecting(false);
    }
  }, [sseStream]);

  /**
   * Disconnect from stream
   */
  const disconnect = useCallback(() => {
    isConnectingRef.current = false;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    sseStream.disconnect();
    setIsConnected(false);
    setIsConnecting(false);
  }, [sseStream]);

  return useMemo(() => ({
    connect,
    disconnect,
    get isConnected() { return isConnected; },
    get isConnecting() { return isConnecting; },
    get error() { return error; },
  }), [connect, disconnect]);
};

// ============================================================================
// BUILD STREAM CONNECTION HOOK
// ============================================================================

export interface UseBuildStreamOptions {
  // Terminal integration (optional)
  terminalRef?: React.MutableRefObject<Terminal | null>;
  autoWriteToTerminal?: boolean;
  
  // Callbacks
  callbacks?: BuildMessageCallbacks;
  
  // Lifecycle
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

export interface UseBuildStreamReturn {
  connect: (deploymentId: string, startBuild?: boolean) => Promise<void>;
  disconnect: () => void;
  isConnected: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  reconnectAttempts: number;
  error: Error | null;
}

/**
 * Hook for build logs
 * 
 * Usage:
 * ```tsx
 * const build = useBuildStream({
 *   terminalRef,
 *   callbacks: {
 *     onLog: (message, text) => console.log(text),
 *     onPhaseChange: (phase) => setPhase(phase),
 *     onProgress: (step, progress) => setProgress(progress),
 *     onSuccess: () => showToast('Build succeeded!', 'success'),
 *     onFailure: (msg) => showToast(msg, 'error'),
 *   },
 * });
 * 
 * // Start new build
 * build.connect(buildToken, true);
 * 
 * // Attach to existing build
 * build.connect(buildToken, false);
 * ```
 */
export const useBuildStream = (options: UseBuildStreamOptions = {}): UseBuildStreamReturn => {
  const {
    terminalRef,
    autoWriteToTerminal = true,
    callbacks = {},
    onConnect,
    onDisconnect,
    onError,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const activeDeploymentIdRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const isReconnectingRef = useRef(false);
  const terminalStateRef = useRef(false);
  const manualDisconnectRef = useRef(false);
  const lastStartBuildRef = useRef(true);
  const callbacksRef = useRef(callbacks);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    callbacksRef.current = callbacks;
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
    onErrorRef.current = onError;
  }, [callbacks, onConnect, onDisconnect, onError]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const stopReconnects = useCallback(() => {
    terminalStateRef.current = true;
    clearReconnectTimer();
    isReconnectingRef.current = false;
    setIsReconnecting(false);
  }, [clearReconnectTimer]);

  // Create message processor
  const messageProcessor = useMemo(() => createBuildMessageProcessor({
    onLog: (...args) => callbacksRef.current.onLog?.(...args),
    onPhaseChange: (...args) => callbacksRef.current.onPhaseChange?.(...args),
    onProgress: (...args) => callbacksRef.current.onProgress?.(...args),
    onReconnected: (...args) => callbacksRef.current.onReconnected?.(...args),
    onContainerExit: (...args) => callbacksRef.current.onContainerExit?.(...args),
    onPrompt: (...args) => callbacksRef.current.onPrompt?.(...args),
    onServiceStatus: (...args) => callbacksRef.current.onServiceStatus?.(...args),
    onSuccess: (...args) => {
      stopReconnects();
      callbacksRef.current.onSuccess?.(...args);
    },
    onFailure: (...args) => {
      stopReconnects();
      callbacksRef.current.onFailure?.(...args);
    },
    onCanceled: (...args) => {
      stopReconnects();
      callbacksRef.current.onCanceled?.(...args);
    },
  }), [stopReconnects]);

  // Initialize SSE stream
  const sseStream = useSSEStream({
    terminalRef,
    autoWriteToTerminal,
    messageProcessor,
    onConnect: () => {
      const wasReconnecting = isReconnectingRef.current;
      hasConnectedRef.current = true;
      reconnectAttemptsRef.current = 0;
      isReconnectingRef.current = false;
      setReconnectAttempts(0);
      setIsReconnecting(false);
      setIsConnected(true);
      setIsConnecting(false);
      setError(null);
      onConnectRef.current?.();
      if (wasReconnecting) {
        callbacksRef.current.onReconnected?.();
      }
    },
    onDisconnect: () => {
      setIsConnected(false);
      setIsConnecting(false);
      onDisconnectRef.current?.();
      scheduleReconnect();
    },
    onError: (err) => {
      setError(err);
      setIsConnected(false);
      setIsConnecting(false);
      onErrorRef.current?.(err);
      scheduleReconnect(err);
    },
  });
  const disconnectSSE = sseStream.disconnect;

  useEffect(() => {
    return () => {
      manualDisconnectRef.current = true;
      activeDeploymentIdRef.current = null;
      clearReconnectTimer();
      disconnectSSE();
    };
  }, [clearReconnectTimer, disconnectSSE]);

  const connectingRef = useRef(false);

  const openStream = useCallback(async (deploymentId: string, startBuild: boolean, reconnecting = false) => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    lastStartBuildRef.current = startBuild;

    try {
      setIsConnecting(!reconnecting);
      setError(null);

      const baseUrl = getApiBaseUrl();

      if (startBuild) {
        await sseStream.connect(`${baseUrl}deployments/${deploymentId}/build`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          idleTimeoutMs: BUILD_STREAM_IDLE_TIMEOUT_MS,
        });
      } else {
        await sseStream.connect(`${baseUrl}deployments/${deploymentId}/stream`, {
          method: 'GET',
          headers: {
            'Accept': 'text/event-stream',
          },
          idleTimeoutMs: BUILD_STREAM_IDLE_TIMEOUT_MS,
        });
      }
    } finally {
      connectingRef.current = false;
      setIsConnecting(false);
    }
  }, [sseStream]);

  function shouldStopReconnect(error: Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('not found')
    );
  }

  function scheduleReconnect(error?: Error) {
    if (error && shouldStopReconnect(error)) {
      terminalStateRef.current = true;
      isReconnectingRef.current = false;
      setIsReconnecting(false);
      return;
    }

    const deploymentId = activeDeploymentIdRef.current;
    const canReconnect =
      deploymentId &&
      !manualDisconnectRef.current &&
      !terminalStateRef.current &&
      (hasConnectedRef.current || !lastStartBuildRef.current);

    if (!canReconnect || reconnectTimerRef.current) return;

    const nextAttempt = reconnectAttemptsRef.current + 1;
    reconnectAttemptsRef.current = nextAttempt;
    isReconnectingRef.current = true;
    setReconnectAttempts(nextAttempt);
    setIsReconnecting(true);

    const delay = Math.min(
      BUILD_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(nextAttempt - 1, 4),
      BUILD_RECONNECT_MAX_DELAY_MS,
    );

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (
        !activeDeploymentIdRef.current ||
        manualDisconnectRef.current ||
        terminalStateRef.current
      ) {
        isReconnectingRef.current = false;
        setIsReconnecting(false);
        return;
      }

      void openStream(activeDeploymentIdRef.current, false, true);
    }, delay);
  }

  /**
   * Connect to build stream
   */
  const connect = useCallback(async (deploymentId: string, startBuild: boolean = true) => {
    // Prevent duplicate concurrent connections (double-click, remount race)
    if (connectingRef.current) return;

    clearReconnectTimer();
    manualDisconnectRef.current = false;
    terminalStateRef.current = false;
    activeDeploymentIdRef.current = deploymentId;
    hasConnectedRef.current = false;
    isReconnectingRef.current = false;
    reconnectAttemptsRef.current = 0;
    setReconnectAttempts(0);
    setIsReconnecting(false);

    await openStream(deploymentId, startBuild);
  }, [clearReconnectTimer, openStream]);

  /**
   * Disconnect from stream
   */
  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    connectingRef.current = false;
    activeDeploymentIdRef.current = null;
    hasConnectedRef.current = false;
    isReconnectingRef.current = false;
    reconnectAttemptsRef.current = 0;
    clearReconnectTimer();
    sseStream.disconnect();
    setIsConnected(false);
    setIsConnecting(false);
    setIsReconnecting(false);
    setReconnectAttempts(0);
  }, [clearReconnectTimer, sseStream]);

  return {
    connect,
    disconnect,
    isConnected,
    isConnecting,
    isReconnecting,
    reconnectAttempts,
    error,
  };
};

// ============================================================================
// GENERIC SSE CONNECTION HOOK
// ============================================================================

export interface UseSSEConnectionOptions<T = any> {
  // Connection details
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: any;
  
  // Terminal integration (optional)
  terminalRef?: React.MutableRefObject<Terminal | null>;
  autoWriteToTerminal?: boolean;
  
  // Message handling
  onMessage?: (message: T, rawText?: string, rawBytes?: Uint8Array) => void;
  
  // Lifecycle
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

export interface UseSSEConnectionReturn {
  connect: () => Promise<void>;
  disconnect: () => void;
  isConnected: boolean;
  isConnecting: boolean;
  error: Error | null;
}

/**
 * Generic SSE connection hook for custom use cases
 * 
 * Usage:
 * ```tsx
 * const sse = useSSEConnection({
 *   url: 'https://api.example.com/stream',
 *   headers: { Authorization: 'Bearer token' },
 *   onMessage: (message) => console.log(message),
 * });
 * 
 * sse.connect();
 * ```
 */
export const useSSEConnection = <T = any>(
  options: UseSSEConnectionOptions<T>
): UseSSEConnectionReturn => {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    terminalRef,
    autoWriteToTerminal = false,
    onMessage,
    onConnect,
    onDisconnect,
    onError,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initialize SSE stream
  const sseStream = useSSEStream({
    terminalRef,
    autoWriteToTerminal,
    onRawMessage: onMessage as (message: SSEMessage, rawText?: string, rawBytes?: Uint8Array) => void,
    onConnect: () => {
      setIsConnected(true);
      setIsConnecting(false);
      setError(null);
      onConnect?.();
    },
    onDisconnect: () => {
      setIsConnected(false);
      setIsConnecting(false);
      onDisconnect?.();
    },
    onError: (err) => {
      setError(err);
      setIsConnected(false);
      setIsConnecting(false);
      onError?.(err);
    },
  });

  /**
   * Connect to SSE stream
   */
  const connect = useCallback(async () => {
    try {
      setIsConnecting(true);
      setError(null);

      // Create abort controller
      abortControllerRef.current = new AbortController();

      await sseStream.connect(url, {
        method,
        headers: {
          'Accept': 'text/event-stream',
          ...headers,
        },
        body,
      });
    } catch (err: any) {
      console.error('[useSSEConnection] Connection error:', err);
      setError(err);
      setIsConnecting(false);
      onError?.(err);
      throw err;
    }
  }, [url, method, headers, body, sseStream, onError]);

  /**
   * Disconnect from stream
   */
  const disconnect = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    sseStream.disconnect();
    setIsConnected(false);
    setIsConnecting(false);
  }, [sseStream]);

  return {
    connect,
    disconnect,
    isConnected,
    isConnecting,
    error,
  };
};
