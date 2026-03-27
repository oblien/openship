/**
 * SSE Message Processors
 * 
 * These processors define how different types of SSE streams should be handled.
 * Each processor is responsible for parsing and handling messages specific to its use case.
 */

import { SSEMessage, SSEMessageProcessor } from '@/hooks/useSSEStream';

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ============================================================================
// BUILD MESSAGE PROCESSOR
// ============================================================================

export interface ServiceStatusEvent {
  serviceName: string;
  serviceId: string;
  status: "pending" | "deploying" | "running" | "failed";
  error?: string;
  containerId?: string;
  hostPort?: number;
}

export interface BuildMessage extends SSEMessage {
  type: 'log' | 'success' | 'failure' | 'phase' | 'progress' | 'reconnected' | 'complete' | 'end' | 'connected' | 'started' | 'error' | 'cancelled' | 'prompt' | 'service-status' | 'unknown';
  promptId?: string;
  title?: string;
  actions?: Array<{ id: string; label: string; variant?: string }>;
  details?: Record<string, unknown>;
  data?: string;
  success?: boolean;
  message?: string;
  error?: string;
  phase?: string;
  currentStep?: number;
  progress?: number;
  eventId?: number;
  exitCode?: number;
  running?: boolean;
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
  warningMessage?: string;
}

export interface BuildMessageCallbacks {
  onLog?: (message: BuildMessage, rawText?: string, rawBytes?: Uint8Array) => void;
  onSuccess?: (data?: any) => void;
  onFailure?: (message?: string, errorCode?: string, errorDetails?: Record<string, unknown>) => void;
  onCanceled?: (message?: string) => void;
  onPhaseChange?: (phase: string) => void;
  onProgress?: (currentStep: number, progress: number) => void;
  onReconnected?: () => void;
  onContainerExit?: (exitCode: number, message?: string) => void;
  onPrompt?: (prompt: {
    promptId: string;
    title: string;
    message: string;
    actions: Array<{ id: string; label: string; variant?: string }>;
    details?: Record<string, unknown>;
  }) => void;
  onServiceStatus?: (status: ServiceStatusEvent) => void;
}

export const createBuildMessageProcessor = (
  callbacks: BuildMessageCallbacks = {}
): SSEMessageProcessor<BuildMessage> => {
  return {
    parseMessage: (jsonData: any): BuildMessage => {
      // Complete message
      if (jsonData?.type === 'complete') {
        return { type: 'complete', ...jsonData };
      }

      // Container stream end message
      if (jsonData?.type === 'end') {
        return { type: 'end', ...jsonData };
      }

      // Container connected message
      if (jsonData?.type === 'connected') {
        return { type: 'connected', ...jsonData };
      }

      // Container error message
      if (jsonData?.type === 'error' && !jsonData?.success) {
        return { type: 'error', ...jsonData };
      }

      // Per-service status update (compose projects)
      if (jsonData?.type === 'service-status') {
        return { type: 'service-status', ...jsonData };
      }

      // Prompt message (pipeline waiting for user decision)
      if (jsonData?.type === 'prompt') {
        return { type: 'prompt', ...jsonData };
      }

      // Reconnected message
      if (jsonData?.type === 'reconnected') {
        return { type: 'reconnected', ...jsonData };
      }

      // Canceled message
      if (jsonData?.type === 'cancelled') {
        return { type: 'cancelled', ...jsonData };
      }

      // Started — build acknowledged, NOT a success event
      if (jsonData?.type === 'started') {
        return { type: 'started', ...jsonData };
      }

      // Log message (must be checked before success/failure catch-all)
      if (jsonData?.type === 'log' && jsonData?.data) {
        return { type: 'log', ...jsonData };
      }

      // Progress update (must be before success/failure catch-all)
      if (jsonData?.type === 'progress') {
        return { type: 'progress', ...jsonData };
      }

      // Success message (catch-all for { success: true })
      if (jsonData?.success === true) {
        return { type: 'success', ...jsonData };
      }

      // Failure message (catch-all for { success: false })
      if (jsonData?.success === false) {
        return { type: 'failure', ...jsonData };
      }

      // Phase change
      if (jsonData?.phase) {
        return { type: 'phase', ...jsonData };
      }

      // Progress update (fallback for messages without explicit type)
      if (jsonData?.currentStep !== undefined || jsonData?.progress !== undefined) {
        return { type: 'progress', ...jsonData };
      }

      return { type: 'unknown', ...jsonData };
    },

    handleMessage: (message, context) => {
      const { rawText, rawBytes, writeToTerminal } = context;

      switch (message.type) {
        case 'complete':
          if (message.success === true) {
            callbacks.onSuccess?.(message);
          } else if (message.success === false) {
            callbacks.onFailure?.(
              message.message || message.error || 'Build completed with errors',
              message.errorCode,
              message.errorDetails,
            );
          }
          break;

        case 'reconnected':
          callbacks.onReconnected?.();
          break;

        case 'progress':
          if (message.currentStep !== undefined && message.progress !== undefined) {
            callbacks.onProgress?.(message.currentStep, message.progress);
          }
          // Also write log if it exists
          if (message.data && rawBytes) {
            writeToTerminal?.(rawBytes);
            callbacks.onLog?.(message, rawText, rawBytes);
          }
          break;

        case 'success':
          callbacks.onSuccess?.(message);
          break;

        case 'failure':
          callbacks.onFailure?.(message.message || message.error, message.errorCode, message.errorDetails);
          break;

        case 'cancelled':
          callbacks.onCanceled?.(message.message || 'Build cancelled by user');
          break;

        case 'phase':
          callbacks.onPhaseChange?.(message.phase!);
          // Phase messages also have log data
          if (message.data && rawBytes) {
            writeToTerminal?.(rawBytes);
            callbacks.onLog?.(message, rawText, rawBytes);
          }
          break;

        case 'log':
          if (message.data && rawBytes) {
            writeToTerminal?.(rawBytes);
            callbacks.onLog?.(message, rawText, rawBytes);
          }
          break;

        case 'end':
          // Container stream ended - check exit code
          if (message.exitCode !== undefined && message.exitCode !== 0) {
            const exitMessage = message.message || `Container exited with code ${message.exitCode}`;
            callbacks.onContainerExit?.(message.exitCode, exitMessage);
          }
          break;

        case 'connected':
          // Container connected - check if it's running
          if (message.running === false && message.exitCode !== undefined && message.exitCode !== 0) {
            const exitMessage = `Container not running (exit code: ${message.exitCode})`;
            callbacks.onContainerExit?.(message.exitCode, exitMessage);
          }
          break;

        case 'error':
          const errorMsg = message.error || message.message || 'Container error occurred';
          callbacks.onFailure?.(errorMsg, message.errorCode, message.errorDetails);
          break;

        case 'prompt':
          if (message.promptId && message.message) {
            callbacks.onPrompt?.({
              promptId: message.promptId,
              title: message.title || 'Action Required',
              message: message.message,
              actions: message.actions || [],
              details: message.details,
            });
          }
          break;

        case 'started':
          // Build acknowledged — nothing to do, logs will follow
          break;

        case 'service-status':
          callbacks.onServiceStatus?.({
            serviceName: (message as any).serviceName ?? '',
            serviceId: (message as any).serviceId ?? '',
            status: (message as any).status ?? 'pending',
            error: (message as any).error,
            containerId: (message as any).containerId,
            hostPort: (message as any).hostPort,
          });
          break;
      }

      return true; // Continue processing
    },
  };
};

// ============================================================================
// LIVE LOGS MESSAGE PROCESSOR
// ============================================================================

export interface LogMessage extends SSEMessage {
  type: 'log' | 'connected' | 'error' | 'end' | 'unknown';
  data?: string;
  message?: string;
  error?: string;
  exitCode?: number;
  running?: boolean;
}

export interface LogMessageCallbacks {
  onLog?: (message: LogMessage, rawText?: string, rawBytes?: Uint8Array) => void;
  onError?: (message: string) => void;
  onContainerExit?: (exitCode: number, message?: string) => void;
}

export const createLogMessageProcessor = (
  callbacks: LogMessageCallbacks = {}
): SSEMessageProcessor<LogMessage> => {
  return {
    parseMessage: (jsonData: any): LogMessage => {
      // Container connected
      if (jsonData?.type === 'connected') {
        return { type: 'connected', ...jsonData };
      }

      // Container error
      if (jsonData?.type === 'error') {
        return { type: 'error', ...jsonData };
      }

      // Container stream end
      if (jsonData?.type === 'end') {
        return { type: 'end', ...jsonData };
      }

      // Log message (most common)
      if (jsonData?.type === 'log' || jsonData?.data) {
        return { type: 'log', ...jsonData };
      }

      return { type: 'unknown', ...jsonData };
    },

    handleMessage: (message, context) => {
      const { rawText, rawBytes, writeToTerminal } = context;

      switch (message.type) {
        case 'log':
          if (message.data && rawBytes) {
            // Base64-encoded binary data — write to terminal
            writeToTerminal?.(rawBytes);
            callbacks.onLog?.(message, rawText, rawBytes);
          } else if (message.message) {
            // Plain text fallback (no base64 data)
            const text = message.message;
            const encoder = new TextEncoder();
            const bytes = encoder.encode(text);
            writeToTerminal?.(bytes);
            callbacks.onLog?.(message, text, bytes);
          }
          break;

        case 'connected':
          // Container connected - check if it's running
          if (message.running === false && message.exitCode !== undefined && message.exitCode !== 0) {
            const exitMessage = `Container not running (exit code: ${message.exitCode})`;
            callbacks.onContainerExit?.(message.exitCode, exitMessage);
          }
          break;

        case 'end':
          // Container stream ended
          if (message.exitCode !== undefined && message.exitCode !== 0) {
            const exitMessage = message.message || `Container exited with code ${message.exitCode}`;
            callbacks.onContainerExit?.(message.exitCode, exitMessage);
          }
          break;

        case 'error':
          const errorMsg = message.error || message.message || 'Container error occurred';
          callbacks.onError?.(errorMsg);
          break;
      }

      return true; // Continue processing
    },
  };
};

// ============================================================================
// GENERIC/PASSTHROUGH MESSAGE PROCESSOR
// ============================================================================

export interface GenericMessage extends SSEMessage {
  type: string;
  [key: string]: any;
}

export const createGenericMessageProcessor = (
  onMessage?: (message: GenericMessage, context: {
    rawText?: string;
    rawBytes?: Uint8Array;
    writeToTerminal?: (bytes: Uint8Array) => void;
  }) => void
): SSEMessageProcessor<GenericMessage> => {
  return {
    parseMessage: (jsonData: any): GenericMessage => {
      return {
        type: jsonData?.type || 'message',
        ...jsonData,
      };
    },

    handleMessage: (message, context) => {
      onMessage?.(message, context);
      return true;
    },
  };
};

