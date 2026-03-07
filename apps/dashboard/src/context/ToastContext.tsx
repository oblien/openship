'use client';

import React, { createContext, useState, useContext, ReactNode, useCallback, memo } from 'react';
import styles from '@/styles/Toast.module.css';

interface ToastContextProps {
  showToast: (message: string, type: 'success' | 'error', title?: string) => void;
}

const ToastContext = createContext<ToastContextProps | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

interface ToastProviderProps {
  children: ReactNode;
}

interface ToastNotification {
  id: string;
  message: string;
  type: 'success' | 'error';
  title?: string;
}

// Memoized Toast component to prevent unnecessary re-renders
const ToastItem = memo(({ toast, onRemove }: { toast: ToastNotification, onRemove: (id: string) => void }) => {
  return (
    <div className={`${styles.toastWrapper} ${styles[toast.type]}`}>
      {toast.title && <h4 className={styles.toastTitle}>{toast.title}</h4>}
      <p className={styles.toastMessage}>{toast.message}</p>
      <button onClick={() => onRemove(toast.id)} className={styles.closeButton}>
        ×
      </button>
    </div>
  );
});

ToastItem.displayName = 'ToastItem';

// Memoized toast container to prevent unnecessary re-renders
const ToastContainer = memo(({ toasts, removeToast }: { toasts: ToastNotification[], removeToast: (id: string) => void }) => {
  return (
    <div className={styles.toastContainer}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
    </div>
  );
});

ToastContainer.displayName = 'ToastContainer';

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const toastCounterRef = React.useRef(0);
  const timeoutRefs = React.useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Generate truly unique ID using counter + timestamp
  const generateUniqueId = useCallback(() => {
    toastCounterRef.current += 1;
    return `toast-${Date.now()}-${toastCounterRef.current}`;
  }, []);

  // Memoize the showToast function to prevent re-renders
  const showToast = useCallback((message: string, type: 'success' | 'error', title?: string) => {
    // Check for duplicate messages (prevent showing identical toasts)
    setToasts((prev) => {
      const isDuplicate = prev.some(
        (toast) => toast.message === message && toast.type === type && toast.title === title
      );
      
      if (isDuplicate) {
        console.log('[Toast] Ignoring duplicate toast:', message);
        return prev; // Don't add duplicate
      }

      const id = generateUniqueId();
      
      // Auto-remove the toast after 5 seconds
      const timeoutId = setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
        timeoutRefs.current.delete(id);
      }, 5000);
      
      // Store timeout reference for cleanup
      timeoutRefs.current.set(id, timeoutId);
      
      return [...prev, { id, message, type, title }];
    });
  }, [generateUniqueId]);

  // Memoize the removeToast function to prevent re-renders
  const removeToast = useCallback((id: string) => {
    // Clear the auto-remove timeout if it exists
    const timeoutId = timeoutRefs.current.get(id);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutRefs.current.delete(id);
    }
    
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // Cleanup all timeouts on unmount
  React.useEffect(() => {
    return () => {
      timeoutRefs.current.forEach((timeoutId) => clearTimeout(timeoutId));
      timeoutRefs.current.clear();
    };
  }, []);

  // Value is memoized to prevent context consumers from re-rendering unnecessarily
  const contextValue = React.useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  );
};

export default ToastProvider; 