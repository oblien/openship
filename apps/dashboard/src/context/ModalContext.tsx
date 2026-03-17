'use client';

import React, { createContext, useContext, useState, useCallback, ReactNode, memo, useRef, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';

interface ModalButton {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}

interface ModalSwitch {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

interface ModalConfig {
  title?: string;
  message?: string;
  icon?: string;
  buttons?: ModalButton[];
  switches?: ModalSwitch[];
  onClose?: () => void;
  closable?: boolean;
  showCloseButton?: boolean;
  customContent?: React.ReactNode;
  width?: string;
  maxWidth?: string;
  minWidth?: string;
  minHeight?: string;
  zIndex?: number;
  height?: string;
  maxHeight?: string;
  overflow?: 'hidden' | 'auto';
}

interface ModalInstance {
  id: string;
  config: ModalConfig;
  zIndex: number;
}

interface ModalContextType {
  showModal: (config: ModalConfig) => string; // Returns modal ID
  hideModal: (id?: string) => void; // Close specific modal or top modal
  hideAllModals: () => void; // Close all modals
}

const ModalContext = createContext<ModalContextType | undefined>(undefined);

export const useModal = () => {
  const context = useContext(ModalContext);
  if (!context) {
    throw new Error('useModal must be used within a ModalProvider');
  }
  return context;
};

interface ModalProviderProps {
  children: ReactNode;
}

const BASE_Z_INDEX = 10000;
const Z_INDEX_STEP = 100;

// Separate component to prevent children re-render
const ModalProviderInner: React.FC<{ children: ReactNode }> = memo(({ children }) => {
  return <>{children}</>;
});

ModalProviderInner.displayName = 'ModalProviderInner';

export const ModalProvider: React.FC<ModalProviderProps> = ({ children }) => {
  const [modals, setModals] = useState<ModalInstance[]>([]);

  // Stable function references that don't change on every render
  const showModal = useCallback((config: ModalConfig): string => {
    const id = `modal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    setModals(prev => {
      const zIndex = config.zIndex || (BASE_Z_INDEX + (prev.length * Z_INDEX_STEP));
      return [...prev, { id, config, zIndex }];
    });

    return id;
  }, []); // No dependencies - stable reference

  const hideModal = useCallback((id?: string) => {
    setModals(prev => {
      if (!id) {
        // Close top modal
        if (prev.length === 0) return prev;
        const topModal = prev[prev.length - 1];
        if (topModal.config.onClose) {
          topModal.config.onClose();
        }
        return prev.slice(0, -1);
      }

      // Close specific modal
      const modalToClose = prev.find(m => m.id === id);
      if (modalToClose?.config.onClose) {
        modalToClose.config.onClose();
      }
      return prev.filter(m => m.id !== id);
    });
  }, []); // No dependencies - stable reference

  const hideAllModals = useCallback(() => {
    setModals(prev => {
      prev.forEach(modal => {
        if (modal.config.onClose) {
          modal.config.onClose();
        }
      });
      return [];
    });
  }, []); // No dependencies - stable reference

  // Memoize context value - only changes if function references change (they won't!)
  const contextValue = useMemo(
    () => ({
      showModal,
      hideModal,
      hideAllModals,
    }),
    [showModal, hideModal, hideAllModals]
  );

  return (
    <ModalContext.Provider value={contextValue}>
      {/* Memoized children - won't re-render when modals state changes */}
      <ModalProviderInner>{children}</ModalProviderInner>

      {/* Modal portal - renders outside children tree */}
      {modals.map((modalInstance, index) => (
        <ModalRenderer
          key={modalInstance.id}
          instance={modalInstance}
          onClose={() => hideModal(modalInstance.id)}
          isTop={index === modals.length - 1}
        />
      ))}
    </ModalContext.Provider>
  );
};

// Modal Renderer Component
interface ModalRendererProps {
  instance: ModalInstance;
  onClose: () => void;
  isTop: boolean;
}

const ModalRenderer: React.FC<ModalRendererProps> = memo(({ instance = { config: { closable: true, showCloseButton: false } }, onClose, isTop }) => {
  const { config, zIndex } = instance;
  const [switchStates, setSwitchStates] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    config.switches?.forEach(sw => {
      initial[sw.id] = sw.checked;
    });
    return initial;
  });

  const handleClose = () => {
    if (config.closable !== false) {
      onClose();
    }
  };

  const handleSwitchChange = (switchId: string, checked: boolean) => {
    setSwitchStates(prev => ({ ...prev, [switchId]: checked }));
    const switchConfig = config.switches?.find(sw => sw.id === switchId);
    if (switchConfig?.onChange) {
      switchConfig.onChange(checked);
    }
  };

  const getButtonStyle = (variant?: string) => {
    switch (variant) {
      case 'primary':
        return 'bg-primary text-primary-foreground hover:bg-primary/90';
      case 'danger':
        return 'bg-red-600 text-white hover:bg-red-700';
      case 'secondary':
      default:
        return 'bg-muted text-foreground hover:bg-muted/80 border border-border';
    }
  };

  const modalContent = config.customContent ? (
    config.customContent
  ) : (
    <div className="p-6">
      {/* Header - Only show if title exists */}
      {(config.title || (config.showCloseButton !== false && config.closable !== false)) && (
        <div className="flex items-start justify-between mb-4">
          {config.title && (
            <div className="flex-1">
              <h3 className="text-xl font-bold text-foreground mb-1">
                {config.title}
              </h3>
            </div>
          )}
        </div>
      )}

      {/* Message */}
      {config.message && (
        <div className="mb-6">
          <p className="text-muted-foreground text-sm leading-relaxed">
            {config.message}
          </p>
        </div>
      )}

      {/* Switches */}
      {config.switches && config.switches.length > 0 && (
        <div className="space-y-3 mb-6 p-4 bg-muted/50 rounded-xl">
          {config.switches.map((switchConfig) => (
            <label
              key={switchConfig.id}
              className="flex items-center justify-between cursor-pointer group"
            >
              <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                {switchConfig.label}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={switchStates[switchConfig.id]}
                onClick={() => handleSwitchChange(switchConfig.id, !switchStates[switchConfig.id])}
                className={`
                  relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                  ${switchStates[switchConfig.id] ? 'bg-primary' : 'bg-muted-foreground/30'}
                `}
              >
                <span
                  className={`
                    inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                    ${switchStates[switchConfig.id] ? 'translate-x-6' : 'translate-x-1'}
                  `}
                />
              </button>
            </label>
          ))}
        </div>
      )}

      {/* Buttons */}
      {!config.customContent && config.buttons && config.buttons.length > 0 && (
        <div className="flex gap-3">
          {config.buttons.map((button, index) => (
            <button
              key={index}
              onClick={() => {
                button.onClick();
                if (button.variant !== 'secondary') {
                  handleClose();
                }
              }}
              disabled={button.disabled}
              className={`
                flex-1 px-4 py-3 rounded-xl font-semibold text-sm transition-all
                disabled:opacity-50 disabled:cursor-not-allowed
                ${getButtonStyle(button.variant)}
              `}
            >
              {button.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Modal
      isOpen={true}
      onClose={handleClose}
      minWidth={config.minWidth || 'auto'}
      minHeight={config.minHeight || 'auto'}
      width={config.width || 'auto'}
      maxWidth={config.maxWidth || '80vw'}
      maxHeight={config.maxHeight || '90vh'}
      height={config.height || 'auto'}
      showCloseButton={config.showCloseButton !== false && config.closable !== false}
      closable={config.closable !== false}
      zIndex={zIndex}
      overflow={config.overflow || 'auto'}
    >
      {modalContent}
    </Modal>
  );
});

export default ModalProvider;
