import { useCallback, useRef, useState } from 'react';
import { connectToBuildStream, reconnectToBuildStream, NoRetryError } from '@/lib/sseClient';
import { useToast } from '@/context/ToastContext';

interface UseBuildConnectionOptions {
  onMessage: (chunk: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  onSuccess?: () => void;
  onFailure?: () => void;
}

interface BuildConnectionState {
  isConnecting: boolean;
  isReconnecting: boolean;
  reconnectAttempts: number;
}

const MAX_RECONNECT_ATTEMPTS = 5;

export const useBuildConnection = (options: UseBuildConnectionOptions) => {
  const { showToast } = useToast();
  const [state, setState] = useState<BuildConnectionState>({
    isConnecting: false,
    isReconnecting: false,
    reconnectAttempts: 0,
  });

  const buildTokenRef = useRef<string | null>(null);
  const buildOptionsRef = useRef<any>(null);
  const lastEventIdRef = useRef<number | undefined>(undefined);
  const isActiveRef = useRef<boolean>(false);
  const reconnectAttemptsRef = useRef<number>(0);

  /**
   * Connect to a new build or attach to existing one
   */
  const connect = useCallback(async (
    buildToken: string,
    buildOptions?: any,
    lastEventId?: number
  ) => {
    buildTokenRef.current = buildToken;
    buildOptionsRef.current = buildOptions;
    lastEventIdRef.current = lastEventId;
    isActiveRef.current = true;

    setState(prev => ({ ...prev, isConnecting: true, reconnectAttempts: 0 }));
    reconnectAttemptsRef.current = 0;

    try {
      console.log('[BuildConnection] Connecting to build stream...');
      
      // If we have buildOptions, it's a new build, otherwise attach to existing
      if (buildOptions) {
        await connectToBuildStream(buildToken, {
          onMessage: options.onMessage,
          onConnect: () => {
            console.log('[BuildConnection] Connected to new build');
            setState(prev => ({ ...prev, isConnecting: false }));
            options.onConnect?.();
          },
          onDisconnect: () => {
            console.log('[BuildConnection] Build stream disconnected');
            options.onDisconnect?.();
            // Auto-reconnect if still active and haven't exceeded attempts
            if (isActiveRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
              reconnect();
            }
          },
          onError: (error) => {
            console.error('[BuildConnection] Build stream error:', error);
            
            // Check if this is a NoRetryError - if so, stop immediately
            if (error instanceof NoRetryError || error.name === 'NoRetryError') {
              console.log('[BuildConnection] Terminal error - stopping:', error.message);
              isActiveRef.current = false;
              setState(prev => ({ ...prev, isConnecting: false }));
              showToast(error.message, 'error', 'Build Failed');
              options.onError?.(error);
              return;
            }
            
            // If token already in use, switch to attach mode
            if (error.message?.includes('Token already in use')) {
              console.log('[BuildConnection] Token in use, switching to attach mode');
              showToast('Build already in progress, attaching...', 'success', 'Reconnecting');
              setTimeout(() => reconnect(), 1000);
            } else {
              options.onError?.(error);
              if (isActiveRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
                setTimeout(() => reconnect(), 2000);
              }
            }
          },
        });
      } else {
        // Attach to existing build
        await reconnectToBuildStream(buildToken, lastEventId, {
          onMessage: options.onMessage,
          onConnect: () => {
            console.log('[BuildConnection] Attached to existing build');
            setState(prev => ({ ...prev, isConnecting: false, reconnectAttempts: 0 }));
            reconnectAttemptsRef.current = 0;
            options.onConnect?.();
          },
          onDisconnect: () => {
            console.log('[BuildConnection] Attached stream disconnected');
            options.onDisconnect?.();
            // Auto-reconnect if still active and haven't exceeded attempts
            if (isActiveRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
              reconnect();
            }
          },
          onError: (error) => {
            console.error('[BuildConnection] Attach error:', error);
            
            // Check if this is a NoRetryError - if so, stop immediately
            if (error instanceof NoRetryError || error.name === 'NoRetryError') {
              console.log('[BuildConnection] Terminal error during attach - stopping:', error.message);
              isActiveRef.current = false;
              setState(prev => ({ ...prev, isConnecting: false }));
              showToast(error.message, 'error', 'Build Failed');
              options.onError?.(error);
              return;
            }
            
            options.onError?.(error);
            if (isActiveRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
              setTimeout(() => reconnect(), 2000);
            }
          },
        });
      }
    } catch (err: any) {
      console.error('[BuildConnection] Failed to connect:', err);
      setState(prev => ({ ...prev, isConnecting: false }));
      
      // Check if this is a NoRetryError - if so, stop immediately
      if (err instanceof NoRetryError || err.name === 'NoRetryError') {
        console.log('[BuildConnection] Terminal error during connect - stopping:', err.message);
        isActiveRef.current = false;
        showToast(err.message, 'error', 'Build Failed');
        options.onError?.(err);
        return;
      }
      
      // If token already in use, switch to attach mode
      if (err.message?.includes('Token already in use')) {
        console.log('[BuildConnection] Token in use, switching to attach mode');
        showToast('Build already in progress, attaching...', 'success', 'Reconnecting');
        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          setTimeout(() => reconnect(), 1000);
        }
      } else {
        options.onError?.(err);
      }
    }
  }, [options, showToast]);

  /**
   * Reconnect to existing build session
   */
  const reconnect = useCallback(async () => {
    if (!buildTokenRef.current || !isActiveRef.current) {
      console.log('[BuildConnection] Reconnection skipped - no token or inactive');
      return;
    }

    // Get current attempts before updating
    const currentAttempts = reconnectAttemptsRef.current;
    const newAttempts = currentAttempts + 1;
    
    if (newAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error('[BuildConnection] Max reconnection attempts reached');
      showToast('Unable to reconnect after multiple attempts', 'error', 'Connection Error');
      isActiveRef.current = false;
      options.onError?.(new Error('Max reconnection attempts reached'));
      setState(prev => ({ ...prev, isReconnecting: false }));
      return;
    }

    // Update both ref and state
    reconnectAttemptsRef.current = newAttempts;
    setState(prev => {
      console.log(`[BuildConnection] Reconnecting... (Attempt ${newAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      showToast(
        `Reconnecting... (Attempt ${newAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
        'success',
        'Reconnecting'
      );

      return { ...prev, isReconnecting: true, reconnectAttempts: newAttempts };
    });

    // Exponential backoff using current attempts
    const delay = Math.min(Math.pow(2, currentAttempts) * 1000, 10000);
    await new Promise(resolve => setTimeout(resolve, delay));

    // Check if still active after delay
    if (!isActiveRef.current) {
      console.log('[BuildConnection] Connection became inactive during delay');
      setState(prev => ({ ...prev, isReconnecting: false }));
      return;
    }

    try {
      await reconnectToBuildStream(
        buildTokenRef.current,
        lastEventIdRef.current,
        {
          onMessage: options.onMessage,
          onConnect: () => {
            console.log('[BuildConnection] Reconnected successfully');
            reconnectAttemptsRef.current = 0;
            setState(prev => ({ ...prev, isReconnecting: false, reconnectAttempts: 0 }));
            showToast('Reconnected successfully', 'success', 'Connected');
            options.onConnect?.();
          },
          onDisconnect: () => {
            console.log('[BuildConnection] Reconnected stream disconnected');
            setState(prev => ({ ...prev, isReconnecting: false }));
            options.onDisconnect?.();
            // Only try again if still active and haven't exceeded attempts
            if (isActiveRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
              setTimeout(() => reconnect(), 1000);
            } else if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
              console.error('[BuildConnection] Max reconnection attempts reached after disconnect');
              isActiveRef.current = false;
              showToast('Unable to reconnect after multiple attempts', 'error', 'Connection Error');
            }
          },
          onError: (error) => {
            console.error('[BuildConnection] Reconnection error:', error);
            setState(prev => ({ ...prev, isReconnecting: false }));
            
            // Check if this is a NoRetryError - if so, stop immediately
            if (error instanceof NoRetryError || error.name === 'NoRetryError') {
              console.log('[BuildConnection] Terminal error - stopping reconnection:', error.message);
              isActiveRef.current = false;
              showToast(error.message, 'error', 'Connection Stopped');
              options.onError?.(error);
              return;
            }
            
            options.onError?.(error);
            // Only try again if still active and haven't exceeded attempts
            if (isActiveRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
              setTimeout(() => reconnect(), 2000);
            } else if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
              console.error('[BuildConnection] Max reconnection attempts reached after error');
              isActiveRef.current = false;
              showToast('Unable to reconnect after multiple attempts', 'error', 'Connection Error');
            }
          },
        }
      );
    } catch (err: any) {
      console.error('[BuildConnection] Reconnection failed:', err);
      setState(prev => ({ ...prev, isReconnecting: false }));
      
      // Check if this is a NoRetryError - if so, stop immediately
      if (err instanceof NoRetryError || err.name === 'NoRetryError') {
        console.log('[BuildConnection] Terminal error - stopping reconnection:', err.message);
        isActiveRef.current = false;
        showToast(err.message, 'error', 'Connection Stopped');
        options.onError?.(err);
        return;
      }
      
      // Check if session no longer exists
      if (err.message?.includes('not found') || err.message?.includes('Invalid token')) {
        console.log('[BuildConnection] Session no longer exists');
        isActiveRef.current = false;
        showToast('Build session no longer exists', 'error', 'Connection Error');
        options.onError?.(err);
        return;
      }
      
      // Only retry if still active and haven't exceeded attempts
      if (isActiveRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        setTimeout(() => reconnect(), 2000);
      } else if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[BuildConnection] Max reconnection attempts reached');
        isActiveRef.current = false;
        showToast('Unable to reconnect after multiple attempts', 'error', 'Connection Error');
      }
    }
  }, [options, showToast]);

  /**
   * Update last event ID (for reconnection)
   */
  const updateLastEventId = useCallback((eventId: number) => {
    lastEventIdRef.current = eventId;
  }, []);

  /**
   * Update build options (to keep in sync with context config)
   */
  const updateBuildOptions = useCallback((buildOptions: any) => {
    buildOptionsRef.current = buildOptions;
  }, []);

  /**
   * Disconnect from build
   */
  const disconnect = useCallback(() => {
    console.log('[BuildConnection] Disconnecting...');
    isActiveRef.current = false;
    buildTokenRef.current = null;
    buildOptionsRef.current = null;
    lastEventIdRef.current = undefined;
    reconnectAttemptsRef.current = 0;
    setState({
      isConnecting: false,
      isReconnecting: false,
      reconnectAttempts: 0,
    });
  }, []);

  return {
    connect,
    reconnect,
    disconnect,
    updateLastEventId,
    updateBuildOptions,
    isConnecting: state.isConnecting,
    isReconnecting: state.isReconnecting,
    reconnectAttempts: state.reconnectAttempts,
  };
};

