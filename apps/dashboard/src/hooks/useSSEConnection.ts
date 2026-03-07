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

import { useCallback, useRef, useState } from 'react';
import { SSEMessage, useSSEStream } from './useSSEStream';
import { createLogMessageProcessor, createBuildMessageProcessor, LogMessageCallbacks, BuildMessageCallbacks } from '@/lib/sseMessageProcessors';
import { deployApi, getAuthToken } from '@/lib/api';
import type { Terminal } from '@xterm/xterm';

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
  connect: (projectId: string) => Promise<void>;
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

  // Create message processor
  const messageProcessor = createLogMessageProcessor(callbacks);

  // Initialize SSE stream
  const sseStream = useSSEStream({
    terminalRef,
    autoWriteToTerminal,
    messageProcessor,
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
   * Connect to live logs stream
   */

  let isConnectingRef = useRef(false);
  const connect = useCallback(async (projectId: string) => {
    try {
      if(isConnectingRef.current) return
      setIsConnecting(true);
      isConnectingRef.current = true;
      setError(null);

      // Get logs token from API
      const logsToken = await deployApi.getLogsAccess(projectId);

      if (!logsToken?.token) {
        throw new Error('Failed to get logs token');
      }

      // Create abort controller
      abortControllerRef.current = new AbortController();

      // Connect to logs stream
      const url = 'https://deploy.oblien.com/logs/containers/stream';
      
      await sseStream.connect(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${logsToken.token}`,
          'Accept': 'text/event-stream',
        },
      });
    } catch (err: any) {
      console.error('[useLogStream] Connection error:', err);
      setError(err);
      onError?.(err);
      throw err;
    }finally {
      isConnectingRef.current = false;
      setIsConnecting(false);
    }
  }, [sseStream, onError]);

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
  connect: (buildToken: string, startBuild?: boolean) => Promise<void>;
  disconnect: () => void;
  isConnected: boolean;
  isConnecting: boolean;
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
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Create message processor
  const messageProcessor = createBuildMessageProcessor(callbacks);

  // Initialize SSE stream
  const sseStream = useSSEStream({
    terminalRef,
    autoWriteToTerminal,
    messageProcessor,
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
   * Connect to build stream
   */
  const connect = useCallback(async (buildToken: string, startBuild: boolean = true) => {
    try {
      setIsConnecting(true);
      setError(null);

      const token = await getAuthToken();

      // Create abort controller
      abortControllerRef.current = new AbortController();

      // Choose endpoint based on whether we're starting or attaching
      const url = startBuild 
        ? 'https://private.oblien.com/build/start'
        : 'https://private.oblien.com/build/check-session';

      const body = startBuild
        ? { token: buildToken }
        : { token: buildToken, attach: true };

      await sseStream.connect(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err: any) {
      console.error('[useBuildStream] Connection error:', err);
      setError(err);
      setIsConnecting(false);
      onError?.(err);
      throw err;
    }
  }, [sseStream, onError]);

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

