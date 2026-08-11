"use client";

import { useEffect, useRef, useState, useCallback } from 'react';
import { useLogStream } from "@/hooks/useSSEConnection";
import { useDeployment } from "@/context/DeploymentContext";
import TerminalSurface from "./TerminalSurface";

interface BuildTerminalProps {
  onReady?: (terminal: any) => void;
  className?: string;
  theme?: 'light' | 'dark';
  enableContainerStreaming?: boolean;
  // Container streaming props
  onContainerStreamStart?: () => void;
  onContainerExit?: (exitCode: number, message: string) => void;
}

const BuildTerminal: React.FC<BuildTerminalProps> = ({ 
  onReady, 
  className = "", 
  theme = 'light',
  enableContainerStreaming = true,
  onContainerStreamStart,
  onContainerExit: onContainerExitProp
}) => {
  const terminalInstanceRef = useRef<any>(null);
  const [isStreamingContainer, setIsStreamingContainer] = useState(false);
  const { canStreamContainer, state, config } = useDeployment();
  
  // Clean SSE connection using the hook!
  const logStream = useLogStream({
    terminalRef: terminalInstanceRef,
    autoWriteToTerminal: true,
    callbacks: {
      onLog: (message, rawText, rawBytes) => {
        // Container logs are already written to terminal by autoWriteToTerminal
      },
      onError: (message) => {
        console.error('[BuildTerminal] Container logs error:', message);
        setIsStreamingContainer(false);
        if (terminalInstanceRef.current) {
          terminalInstanceRef.current.write('\x1b[1;31m[Container Error: ' + message + ']\x1b[0m\r\n');
        }
      },
      onContainerExit: (exitCode, message) => {
        console.log('[BuildTerminal] Container exited:', exitCode, message);
        setIsStreamingContainer(false);
        hasStartedStreamingRef.current = false; // Reset so it can be attempted again if needed
        containerExitedRef.current = true; // Mark that container has exited
        onContainerExitProp?.(exitCode, message || 'Container exited with error');
      },
    },
    onConnect: () => {
      console.log('[BuildTerminal] Connected to container logs stream');
      setIsStreamingContainer(true);
    },
    onDisconnect: () => {
      console.log('[BuildTerminal] Disconnected from container logs stream');
      setIsStreamingContainer(false);
    },
    onError: (error) => {
      console.error('[BuildTerminal] Container logs stream error:', error);
      setIsStreamingContainer(false);
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.write('\x1b[1;31m[Container Stream Error - Connection Lost]\x1b[0m\r\n');
      }
    },
  });

  // Track if we've already started container streaming to prevent infinite loops
  const hasStartedStreamingRef = useRef(false);
  const hasAttemptedStreamingRef = useRef(false);
  const containerExitedRef = useRef(false);

  // Start container streaming
  const startContainerStreaming = useCallback(async () => {
    if (
      !enableContainerStreaming ||
      !state.projectId ||
      !config.options.hasServer ||
      !canStreamContainer.current ||
      !terminalInstanceRef.current
    ) {
      console.log('[BuildTerminal] Cannot start container streaming - missing requirements', {
        enableContainerStreaming,
        projectId: !!state.projectId,
        hasServer: config.options.hasServer,
        canStream: canStreamContainer.current,
        terminal: !!terminalInstanceRef.current
      });
      return;
    }

    // Prevent duplicate connections
    if (hasStartedStreamingRef.current || isStreamingContainer) {
      console.log('[BuildTerminal] Already streaming or started, skipping');
      return;
    }

    hasStartedStreamingRef.current = true;

    try {
      // Clear terminal and show transition message
      terminalInstanceRef.current.reset();
      terminalInstanceRef.current.write(' Deployment completed successfully! \n');
      terminalInstanceRef.current.write('╭─────────────────────────────────────────╮ \r\n');
      terminalInstanceRef.current.write('│  SWITCHING TO CONTAINER LOGS            │ \r\n');
      terminalInstanceRef.current.write('╰─────────────────────────────────────────╯ \r\n\r\n');
      terminalInstanceRef.current.write(' Connecting to Live Container Stream...] \r\n\r\n');

      // Notify parent component
      onContainerStreamStart?.();

      // Connect using the clean hook - no more manual connection management!
      await logStream.connect(state.projectId);
    } catch (error) {
      console.error('[BuildTerminal] Error starting container streaming:', error);
      hasStartedStreamingRef.current = false; // Reset on error so it can retry
      setIsStreamingContainer(false);
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.write(' [Failed to Start Container Stream]\r\n');
      }
    }
  }, [enableContainerStreaming, state.projectId, config.options.hasServer, isStreamingContainer, logStream, onContainerStreamStart]);

  // Effect to start container streaming when deployment succeeds
  useEffect(() => {
    // Check all conditions including the ref value (read once at effect execution time)
    const canStream = canStreamContainer.current;
    
    if (
      state.deploymentSuccess && 
      enableContainerStreaming &&
      config.options.hasServer && 
      canStream && 
      state.projectId && 
      !isStreamingContainer &&
      !hasStartedStreamingRef.current &&
      !hasAttemptedStreamingRef.current &&
      !containerExitedRef.current
    ) {
      console.log('[BuildTerminal] Deployment successful with container streaming enabled, starting stream');
      hasAttemptedStreamingRef.current = true;
      // Add a small delay to ensure build logs are complete
      const timeoutId = setTimeout(() => {
        startContainerStreaming();
      }, 2000);
      
      return () => clearTimeout(timeoutId);
    }
  }, [enableContainerStreaming, state.deploymentSuccess, config.options.hasServer, state.projectId, isStreamingContainer]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Reset streaming state
      hasStartedStreamingRef.current = false;
      hasAttemptedStreamingRef.current = false;
      containerExitedRef.current = false;
      
      // Disconnect log stream
      if (isStreamingContainer) {
        logStream.disconnect();
      }
    };
  }, [isStreamingContainer, logStream]);

  return (
    <TerminalSurface
      terminalRef={terminalInstanceRef}
      onReady={onReady}
      className={className}
      theme={theme}
    />
  );
};

export default BuildTerminal;
