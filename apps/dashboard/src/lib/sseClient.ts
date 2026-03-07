/**
 * SSE Client Utility
 * Provides helper functions for connecting to SSE endpoints
 */

import { deployApi, getAuthToken } from '@/lib/api';

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
 * Connect to live logs SSE stream
 */
export const connectToLiveLogs = async ({
  projectId = '',
  options = {} as SSEClientOptions,
  streamUrl = ''
}) => {
  // Get logs token from API
  const logsToken = await deployApi.getLogsAccess(projectId);

  if (!logsToken?.token) {
    throw new Error('Failed to get logs token');
  }

  // Use custom stream URL or default
  const url = streamUrl || `https://deploy.oblien.com/logs/containers/stream`;
  
  return connectToSSE(
    url,
    {
      ...options,
      headers: {
        'Authorization': `Bearer ${logsToken.token}`,
        ...options.headers,
      },
    }
  );
};

/**
 * Connect to build logs SSE stream
 */
export const connectToBuildLogs = async (
  deployment_session_id: string,
  options: SSEClientOptions
) => {
  const token = await getAuthToken();
  
  return connectToSSE(
    `https://private.oblien.com/logs/build/${deployment_session_id}`,
    {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        ...options.headers,
      },
    }
  );
};

/**
 * Connect to deployment build stream
 */
export const connectToBuildStream = async (
  buildToken: string,
  options: SSEClientOptions
) => {
  const token = await getAuthToken();
  
  const response = await fetch('https://private.oblien.com/build/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
    body: JSON.stringify({ 
      token: buildToken,
    }),
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
 * Reconnect to existing build session
 */
export const reconnectToBuildStream = async (
  buildToken: string,
  lastEventId: number | undefined,
  options: SSEClientOptions
) => {
  const token = await getAuthToken();
  
  const response = await fetch('https://private.oblien.com/build/check-session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
    body: JSON.stringify({ 
      token: buildToken, 
      attach: true,
      last_event_id: lastEventId
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    
    // Permanent failures should not be retried
    if (response.status === 404 || response.status === 410) {
      throw new NoRetryError(error.error || 'Build session not found');
    }
    
    throw new Error(error.error || 'Failed to reconnect to build');
  }

  // Check if response is JSON (build complete) or SSE stream (build in progress)
  const contentType = response.headers.get('content-type');
  
  // If not SSE stream and not JSON, this is an invalid response - do not retry
  if (!contentType?.includes('text/event-stream') && !contentType?.includes('application/json')) {
    console.error('[SSEClient] Invalid response content-type:', contentType);
    throw new NoRetryError('Invalid response type from server - expected SSE stream or JSON');
  }
  
  if (contentType?.includes('application/json')) {
    // Response is JSON - process it as a message
    const data = await response.json();
    console.log('[SSEClient] Processing JSON response:', data);
    
    // Process missed logs if available
    if (data.missedLogs && Array.isArray(data.missedLogs)) {
      data.missedLogs.forEach((log: any) => {
        // Send each missed log as SSE format
        const sseMessage = `data: ${JSON.stringify(log)}\n\n`;
        options.onMessage(sseMessage);
      });
    }
    
    // Send the main JSON data as SSE format for processing
    const sseMessage = `data: ${JSON.stringify(data)}\n\n`;
    options.onMessage(sseMessage);
    
    // Handle terminal states
    if (data.isActive === false) {
      console.log('[SSEClient] Build is no longer active - stopping reconnection');
      throw new NoRetryError('Build session is no longer active');
    }
    
    if (data.hasActiveConnections === false) {
      console.log('[SSEClient] No active connections for this build - stopping reconnection');
      throw new NoRetryError('Build session has no active connections');
    }
    
    // If data indicates completion or error, handle appropriately
    if (data.type === 'complete' || data.type === 'success' || data.type === 'failure' || data.type === 'cancelled') {
      console.log('[SSEClient] Received terminal message via JSON:', data.type);
      // Let the message be processed, then disconnect
      setTimeout(() => {
        if (data.type === 'failure' || (data.type === 'complete' && data.success === false)) {
          options.onError?.(new NoRetryError(data.message || data.error || 'Build failed'));
        } else {
          options.onDisconnect?.();
        }
      }, 100);
      return { disconnect: () => {} }; // Return dummy disconnect function
    }
    
    // For other JSON responses, continue processing normally
    return { disconnect: () => {} }; // Return dummy disconnect function
  }

  // Validate we actually have text/event-stream before processing
  if (!contentType?.includes('text/event-stream')) {
    console.error('[SSEClient] Response is not SSE stream:', contentType);
    throw new NoRetryError('Response is not a valid SSE stream');
  }

  // Response is SSE stream - process normally
  return processSSEStream(response, options);
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

