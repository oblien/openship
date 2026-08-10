"use client";

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  maxWidth?: string;
  minWidth?: string;
  maxHeight?: string;
  minHeight?: string;
  height?: string;
  showCloseButton?: boolean;
  closable?: boolean; // If false, prevents backdrop clicks from closing
  footer?: ReactNode;
  zIndex?: number; // Support custom z-index for modal layering
  overflow?: 'hidden' | 'auto';
}

export function Modal({
  isOpen,
  onClose,
  children,
  width = 'auto',
  maxWidth = '80vw',
  minWidth = 'auto',
  minHeight = 'auto',
  maxHeight = '90vh',
  height = 'auto',
  showCloseButton = true,
  closable = true,
  footer = null,
  zIndex = 10000,
  overflow = 'auto'
}: ModalProps) {
  const [isVisible, setIsVisible] = useState(false);
  // Portal target only exists after mount (SSR has no document).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (isOpen) {
      // Use requestAnimationFrame to ensure initial state is painted before animation
      const frame = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsVisible(true);
        });
      });
      return () => cancelAnimationFrame(frame);
    } else {
      setIsVisible(false);
    }
  }, [isOpen]);

  if (!isOpen || !mounted) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (closable && e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleBackdropDivClick = () => {
    if (closable) {
      onClose();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex }}
      onClick={handleBackdropClick}
    >
      {/* Backdrop = the theme's OWN scrim token, which is already tuned per
          theme (light 45% black, dark 60%, dim 55%). It used to be
          `bg-background/70`, i.e. 70% WHITE in light mode — a white veil over a
          white page, so nothing dimmed and a white panel had nothing to separate
          from. The blur stays. */}
      <div
        className="absolute inset-0 backdrop-blur-lg dark:backdrop-blur-xl dim:backdrop-blur-xl transition-opacity duration-300"
        style={{ background: "var(--th-overlay)", opacity: isVisible ? 1 : 0 }}
        onClick={handleBackdropDivClick}
      />

      {/* Modal surface: the SOLID card token at 96% + its own blur + shadow, so
          it reads as elevated glass but never shows the page through it (it was
          50%, which in LIGHT let the page ghost through — the "transparent modal"
          bug). NO border at all — the fill + blur + shadow do the lifting; a
          resting border/ring made it read as a boxed panel, not glass. */}
      <div
        className="relative w-full rounded-2xl shadow-2xl backdrop-blur-2xl flex flex-col transition-all duration-300 !overflow-x-hidden"
        style={{
          background: 'color-mix(in oklab, var(--th-card-bg-solid) 96%, transparent)',
          width,
          overflow,
          maxWidth,
          maxHeight,
          height,
          minWidth,
          minHeight,
          opacity: isVisible ? 1 : 0,
          transform: isVisible ? 'scale(1) translateY(0)' : 'scale(0.95) translateY(10px)'
        }}
      >
        {/* Close Button */}
        {showCloseButton && (
          <button
            onClick={onClose}
            className="absolute top-4 end-4 z-10 p-1.5 rounded-lg bg-card hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shadow-sm"
          >
            <X className="w-5 h-5" />
          </button>
        )}

        {/* Content */}
        <div className={`w-full h-full flex flex-col`}>
          {children}
        </div>
        {footer}
      </div>
    </div>,
    document.body,
  );
}

