'use client';

/**
 * Compatibility adapter — NOT a second toast system.
 *
 * The one toast implementation lives in `@/components/toast` (the glassy
 * provider mounted once in layout). This module only preserves the legacy
 * `showToast(message, type, title?)` API for the many call sites that import
 * it, by forwarding into that single provider. `showToast` is memoized so it
 * stays referentially stable across renders (some consumers list it in effect
 * deps), matching the old context's behavior.
 */

import React from 'react';
import { useToast as useGlassyToast } from '@/components/toast';

interface ToastContextProps {
  showToast: (message: string, type: 'success' | 'error' | 'info', title?: string) => void;
}

export const useToast = (): ToastContextProps => {
  const { toast } = useGlassyToast();
  const showToast = React.useCallback(
    (message: string, type: 'success' | 'error' | 'info', title?: string) => toast(type, message, title),
    [toast],
  );
  return React.useMemo(() => ({ showToast }), [showToast]);
};

// Passthrough: the real provider is <ToastProvider> from @/components/toast.
// Kept so any stray mount of this legacy provider is harmless.
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <>{children}</>
);

export default ToastProvider;
