"use client";

import { useEffect, useRef, useState, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useLogStream } from "@/hooks/useSSEConnection";
import { useDeployment } from "@/context/DeploymentContext";

interface BuildTerminalProps {
  onReady?: (terminal: any) => void;
  className?: string;
  mockData?: boolean;
  theme?: 'light' | 'dark';
  // Container streaming props
  onContainerStreamStart?: () => void;
  onContainerExit?: (exitCode: number, message: string) => void;
}

const BuildTerminal: React.FC<BuildTerminalProps> = ({ 
  onReady, 
  className = "", 
  mockData = false, 
  theme = 'light',
  onContainerStreamStart,
  onContainerExit: onContainerExitProp
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<any>(null);
  const isInitializedRef = useRef(false);
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
    if (!state.projectId || !config.options.hasServer || !canStreamContainer.current || !terminalInstanceRef.current) {
      console.log('[BuildTerminal] Cannot start container streaming - missing requirements', {
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
  }, [state.projectId, config.options.hasServer, isStreamingContainer, logStream, onContainerStreamStart]);

  // Effect to start container streaming when deployment succeeds
  useEffect(() => {
    // Check all conditions including the ref value (read once at effect execution time)
    const canStream = canStreamContainer.current;
    
    if (
      state.deploymentSuccess && 
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
  }, [state.deploymentSuccess, config.options.hasServer, state.projectId, isStreamingContainer]);

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

  const initializeTerminal = async () => {
    if (isInitializedRef.current) return;
    isInitializedRef.current = true;
    const { Terminal } = await import('@xterm/xterm');
    const { FitAddon } = await import('@xterm/addon-fit');
    const { WebLinksAddon } = await import('@xterm/addon-web-links');

    try {
      // Create terminal instance with minimal, clean config
      const lightTheme = {
        background: '#ffffff',
        foreground: '#1a1a1a',
        cursor: '#000000',
        cursorAccent: '#ffffff',
        selectionBackground: '#d1d5da',
        black: '#1a1a1a',
        red: '#d73a49',
        green: '#22863a',
        yellow: '#b08800',
        blue: '#0366d6',
        magenta: '#6f42c1',
        cyan: '#1b7c83',
        white: '#6a737d',
        brightBlack: '#959da5',
        brightRed: '#cb2431',
        brightGreen: '#22863a',
        brightYellow: '#dbab09',
        brightBlue: '#0366d6',
        brightMagenta: '#6f42c1',
        brightCyan: '#1b7c83',
        brightWhite: '#1a1a1a',
      };

      const darkTheme = {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#ffffff',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      };

      const terminal = new Terminal({
        fontFamily: 'Consolas, monospace',
        fontSize: 14,
        lineHeight: 1.0,
        letterSpacing: 0,
        theme: theme === 'light' ? lightTheme : darkTheme,
        cursorBlink: true,
        scrollback: 1000,
        convertEol: true,
      });

      // Add fit addon
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());

      // Open terminal in the container
      if (!terminalRef.current) return;

      terminal.open(terminalRef.current);
      terminalInstanceRef.current = terminal;

      const containerElement = terminalRef.current;

      // Fit terminal to container
      setTimeout(() => {
        try {
          fitAddon.fit();
        } catch (e) {
          console.error('Error fitting terminal:', e);
        }
      }, 100);

      // Handle resize
      const handleResize = () => {
        try {
          fitAddon.fit();
          terminal.scrollToBottom();
        } catch (e) {
          console.error('Error resizing terminal:', e);
        }
      };

      const resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(containerElement);
      window.addEventListener('resize', handleResize);

      // Call onReady callback
      if (onReady) {
        onReady(terminal);
      }

      // Add mock data if enabled
      if (mockData) {
        setTimeout(() => {
          terminal.writeln(' Starting build process...');
          terminal.writeln('');
          terminal.writeln('---PHASE: clone---\r\n');
          terminal.writeln('Cloning repository...');
          terminal.writeln('\x1b[32mCloning into \'.\'\x1b[0m');
          terminal.writeln('');
          terminal.writeln('---PHASE: install---\r\n');
          terminal.writeln('npm notice');
          terminal.writeln('npm notice New major version of npm available! 9.6.7 -> 10.9.2');
          terminal.writeln('npm notice Run bun install -g npm@10.9.2 to update!');
          terminal.writeln('npm notice');
          terminal.writeln('');
          terminal.writeln('added 352 packages in 12s');
          terminal.writeln('');
          terminal.writeln('---PHASE: build---\r\n');
          terminal.writeln('> next build');
          terminal.writeln('');
          terminal.writeln('  Next.js 15.3.2');
          terminal.writeln('');
          terminal.writeln('  Creating an optimized production build ...');
          terminal.writeln('  \x1b[32m✓\x1b[0m Compiled successfully in 2000ms');
          terminal.writeln('  \x1b[32m✓\x1b[0m Linting and checking validity of types');
          terminal.writeln('  \x1b[32m✓\x1b[0m Collecting page data');
          terminal.writeln('  \x1b[32m✓\x1b[0m Generating static pages (5/5)');
          terminal.writeln('  \x1b[32m✓\x1b[0m Collecting build traces');
          terminal.writeln('  \x1b[32m✓\x1b[0m Finalizing page optimization');
          terminal.writeln('');
          terminal.writeln('\x1b[1;32m✓ Build completed successfully!\x1b[0m');
        }, 500);
      }

      // Cleanup on unmount
      return () => {
        resizeObserver.disconnect();
        window.removeEventListener('resize', handleResize);
        terminal.dispose();
        terminalInstanceRef.current = null;
      };
    } catch (error) {
      console.error('Error initializing terminal:', error);
    }
  };

  useEffect(() => {
    if (!terminalRef.current || terminalInstanceRef.current || isInitializedRef.current) return;
    initializeTerminal();
  }, [onReady, mockData, theme]);

  return (
    <div
      ref={terminalRef}
      className={`terminal-container w-full h-full ${className}`}
      style={{
        height: "100%",
        width: "100%",
        overflow: "hidden",
        padding: "8px",
        fontSmooth: "antialiased",
        WebkitFontSmoothing: "antialiased",
        MozOsxFontSmoothing: "grayscale"
      }}
    />
  );
};

export default BuildTerminal;

