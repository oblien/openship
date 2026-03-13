import { useCallback, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';

/**
 * Generic SSE Message - can be extended for specific use cases
 */
export interface SSEMessage {
  type: string;
  [key: string]: any;
}

/**
 * Message Processor - handles parsing and processing of SSE messages
 * This is where you define your business logic for different message types
 */
export interface SSEMessageProcessor<T extends SSEMessage = SSEMessage> {
  /**
   * Parse raw JSON data into a typed message
   */
  parseMessage: (jsonData: any) => T;
  
  /**
   * Handle the parsed message
   * Return true to continue processing, false to stop
   */
  handleMessage: (message: T, context: {
    rawText?: string;
    rawBytes?: Uint8Array;
    writeToTerminal?: (bytes: Uint8Array) => void;
  }) => boolean | void;
}

/**
 * Core SSE Stream Options - keeps only essential streaming logic
 */
export interface SSEStreamOptions<T extends SSEMessage = SSEMessage> {
  // Terminal integration (optional)
  terminalRef?: React.MutableRefObject<Terminal | null>;
  autoWriteToTerminal?: boolean;
  
  // Message processing
  messageProcessor?: SSEMessageProcessor<T>;
  
  // Lifecycle callbacks
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  
  // Raw message callback (if you want to handle everything yourself)
  onRawMessage?: (message: T, rawText?: string, rawBytes?: Uint8Array) => void;
}

/**
 * Core SSE Stream Hook - Generic, reusable streaming logic
 * No business logic, just pure SSE processing
 */
export const useSSEStream = <T extends SSEMessage = SSEMessage>(
  options: SSEStreamOptions<T> = {}
) => {
  const {
    terminalRef,
    autoWriteToTerminal = true,
    messageProcessor,
    onConnect,
    onDisconnect,
    onError,
    onRawMessage,
  } = options;

  const abortControllerRef = useRef<AbortController | null>(null);
  const isConnectedRef = useRef(false);
  /** Buffer for incomplete SSE frames across chunks */
  const sseBufferRef = useRef('');

  /**
   * Process and decode base64 log data
   */
  const processLogData = useCallback((data: string): { bytes: Uint8Array; text: string } | null => {
    try {
      // Decode base64 binary data
      const binaryData = atob(data);
      const bytes = new Uint8Array(binaryData.length);
      for (let i = 0; i < binaryData.length; i++) {
        bytes[i] = binaryData.charCodeAt(i);
      }

      // Decode to text
      const textDecoder = new TextDecoder();
      const text = textDecoder.decode(bytes);

      return { bytes, text };
    } catch (err) {
      console.error('Error processing log data:', err);
      return null;
    }
  }, []);

  /**
   * Write log data to terminal
   */
  const writeToTerminal = useCallback((bytes: Uint8Array) => {
    if (terminalRef?.current && autoWriteToTerminal) {
      terminalRef.current.write(bytes);
    }
  }, [terminalRef, autoWriteToTerminal]);

  /**
   * Default message parser - just passes through the data as-is
   */
  const defaultParseMessage = useCallback((jsonData: any): T => {
    return {
      type: jsonData?.type || 'unknown',
      ...jsonData,
    } as T;
  }, []);

  /**
   * Process a chunk of SSE data — properly handles event: + data: lines
   * and message boundaries (\n\n).
   */
  const processSSEChunk = useCallback((chunk: string) => {
    try {
      // Append chunk to buffer for cross-chunk boundary handling
      const buffer = sseBufferRef.current + chunk;

      // SSE messages are separated by \n\n
      const parts = buffer.split('\n\n');

      // Last element may be incomplete — keep in buffer
      sseBufferRef.current = parts.pop() || '';

      for (const part of parts) {
        if (!part.trim()) continue;

        let eventType = 'message';
        let dataStr = '';

        for (const line of part.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event:')) {
            eventType = trimmed.substring(6).trim();
          } else if (trimmed.startsWith('data:')) {
            const d = trimmed.substring(5).trim();
            dataStr = dataStr ? dataStr + '\n' + d : d;
          } else if (trimmed.startsWith('{')) {
            // Direct JSON line (non-SSE format fallback)
            dataStr = trimmed;
          }
        }

        if (!dataStr) continue;

        let jsonData: any;
        try {
          jsonData = JSON.parse(dataStr);
        } catch {
          continue;
        }

        // Inject SSE event type if not present in JSON data
        if (!jsonData.type && eventType !== 'message') {
          jsonData.type = eventType;
        }

        // Parse message using custom parser or default
        const parser = messageProcessor?.parseMessage || defaultParseMessage;
        const message = parser(jsonData);

        // Process log data if present
        let rawText: string | undefined;
        let rawBytes: Uint8Array | undefined;

        if (message.data && typeof message.data === 'string') {
          const processed = processLogData(message.data);
          if (processed) {
            rawText = processed.text;
            rawBytes = processed.bytes;
          }
        }

        // Call raw message callback if provided
        if (onRawMessage) {
          onRawMessage(message, rawText, rawBytes);
        }

        // Use custom message handler if provided
        if (messageProcessor?.handleMessage) {
          const shouldContinue = messageProcessor.handleMessage(message, {
            rawText,
            rawBytes,
            writeToTerminal,
          });

          // If handler returns false, stop processing
          if (shouldContinue === false) {
            break;
          }
        }
      }
    } catch (err) {
      console.error('Error processing SSE chunk:', err);
      onError?.(err as Error);
    }
  }, [messageProcessor, processLogData, writeToTerminal, onRawMessage, onError, defaultParseMessage]);

  /**
   * Connect to SSE endpoint
   */
  const connect = useCallback(async (
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: any;
    } = {}
  ) => {
    // Disconnect existing connection
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Reset SSE buffer
    sseBufferRef.current = '';

    // Create new abort controller
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        try {
          const json = await response.json();
          onError?.(new Error(`SSE connection failed: ${json.error || response.statusText}`));
        } catch (e) {
          onError?.(new Error(`SSE connection failed: ${response.statusText}`));
        }
        throw new Error(`SSE connection failed: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No reader available');
      }

      isConnectedRef.current = true;
      onConnect?.();

      const decoder = new TextDecoder();

      // Read stream
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        processSSEChunk(chunk);
      }

      isConnectedRef.current = false;
      onDisconnect?.();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Connection was intentionally aborted
        isConnectedRef.current = false;
        onDisconnect?.();
      } else {
        console.error('SSE connection error:', err);
        isConnectedRef.current = false;
        onError?.(err);
      }
    }
  }, [processSSEChunk, onConnect, onDisconnect, onError]);

  /**
   * Disconnect from SSE
   */
  const disconnect = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    isConnectedRef.current = false;
    sseBufferRef.current = '';
  }, []);

  /**
   * Check if currently connected
   */
  const isConnected = useCallback(() => {
    return isConnectedRef.current;
  }, []);

  return {
    connect,
    disconnect,
    isConnected,
    processSSEChunk, // Exposed for manual processing
  };
};
