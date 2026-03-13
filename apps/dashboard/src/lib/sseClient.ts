/**
 * SSE Client Utility
 * Provides helper functions for connecting to SSE endpoints
 */

import { getApiBaseUrl } from '@/lib/api';

export interface SSEClientOptions {
  onMessage: (data: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  headers?: Record<string, string>;
}

/**
 * Custom error for terminal failures that should not be retried
 */
export class NoRetryError extends Error {
  public readonly shouldRetry = false;
  
  constructor(message: string) {
    super(message);
    this.name = 'NoRetryError';
  }
}

/**
 * Connect to live logs SSE stream (runtime logs via local API)
 */
export const connectToLiveLogs = async ({
  projectId = '',
  options = {} as SSEClientOptions,
}) => {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}projects/${projectId}/logs/stream`;

  return connectToSSE(url, {
    ...options,
    headers: {
      ...options.headers,
    },
  });
};

/**
 * Connect to build logs SSE stream (via local API)
 */
export const connectToBuildLogs = async (
  deploymentId: string,
  options: SSEClientOptions
) => {
  const baseUrl = getApiBaseUrl();

  return connectToSSE(
    `${baseUrl}deployments/${deploymentId}/build`,
    {
      ...options,
    }
  );
};

/**
 * Start a new build via local API
 */
export const connectToBuildStream = async (
  sessionId: string,
  options: SSEClientOptions
) => {
  const baseUrl = getApiBaseUrl();

  const response = await fetch(`${baseUrl}deployments/${sessionId}/build`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // Check content type and handle accordingly
  const contentType = response.headers.get('content-type');
  
  if (contentType?.includes('application/json')) {
    // Response is JSON - process it as a message
    const data = await response.json();
    console.log('[SSEClient] Processing JSON response from build start:', data);
    
    // Send the JSON data as SSE format for processing
    const sseMessage = `data: ${JSON.stringify(data)}\n\n`;
    
    options.onMessage(sseMessage);
    
    // For other JSON responses, return dummy disconnect
    return { disconnect: () => {} };
  }

  return processSSEStream(response, options);
};

/**
 * Reconnect to existing build session (attach to SSE log stream)
 */
export const reconnectToBuildStream = async (
  sessionId: string,
  lastEventId: number | undefined,
  options: SSEClientOptions
) => {
  const baseUrl = getApiBaseUrl();

  // Use the SSE stream endpoint to re-attach to running build logs
  const url = `${baseUrl}deployments/${sessionId}/stream?sessionId=${sessionId}`;

  return connectToSSE(url, options);
};

/**
 * Generic SSE connection function
 */
export const connectToSSE = async (
  url: string,
  options: SSEClientOptions
) => {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Accept': 'text/event-stream',
      ...options.headers,
    },
  });

  return processSSEStream(response, options);
};

/**
 * Parse SSE message and check for terminal error states
 */
const parseSSEMessage = (chunk: string): { hasTerminalError: boolean; data: any } => {
  try {
    // SSE format is "data: {...}\n\n"
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const dataStr = line.substring(6); // Remove "data: " prefix
        if (dataStr.trim()) {
          const data = JSON.parse(dataStr);
          
          // Check for terminal error states
          // 1. type: "complete" with error field
          if (data.type === 'complete' && data.error) {
            return { hasTerminalError: true, data };
          }
          
          // 2. phase: "failed" or "error"
          if (data.phase === 'failed' || data.phase === 'error') {
            return { hasTerminalError: true, data };
          }
          
          // 3. status: "failed" or "error" with error message
          if ((data.status === 'failed' || data.status === 'error') && data.error) {
            return { hasTerminalError: true, data };
          }
          
          return { hasTerminalError: false, data };
        }
      }
    }
  } catch (e) {
    // Not JSON or invalid format, continue processing
  }
  
  return { hasTerminalError: false, data: null };
};

/**
 * Process SSE stream from response
 */
const processSSEStream = async (
  response: Response,
  options: SSEClientOptions
) => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No reader available');
  }

  options.onConnect?.();

  const decoder = new TextDecoder();
  const abortController = new AbortController();
  let lastMessageHadError = false;

  const readStream = async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        
        // Check for terminal error states before passing to onMessage
        const { hasTerminalError, data } = parseSSEMessage(chunk);
        
        // Always send the message to the UI
        options.onMessage(chunk);
        
        // If this message indicates a terminal error, mark it
        if (hasTerminalError) {
          lastMessageHadError = true;
          console.log('[SSEClient] Detected terminal error state in message:', data);
        }
      }
      
      // Stream ended - check if last message was an error
      if (lastMessageHadError) {
        console.log('[SSEClient] Stream ended with terminal error - preventing reconnection');
        options.onError?.(new NoRetryError('Build completed with error'));
      } else {
        options.onDisconnect?.();
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        options.onError?.(err);
      } else {
        options.onDisconnect?.();
      }
    }
  };

  readStream();

  // Return disconnect function
  return {
    disconnect: () => {
      abortController.abort();
      reader.cancel();
    },
  };
};

