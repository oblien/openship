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
   * Process a chunk of SSE data
   */
  const processSSEChunk = useCallback((chunk: string) => {
    try {
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;

        let jsonData: any;

        // Parse JSON from line (handles both direct JSON and SSE format)
        if (line.trim().startsWith('{')) {
          try {
            jsonData = JSON.parse(line.trim());
          } catch (e) {
            continue;
          }
        } else if (line.trim().startsWith('data:')) {
          const jsonPart = line.substring(line.indexOf(':') + 1).trim();
          try {
            jsonData = JSON.parse(jsonPart);
          } catch (e) {
            continue;
          }
        } else {
          continue;
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

    // Create new abort controller
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
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
