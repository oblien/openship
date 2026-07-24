"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";

const MENU_OFFSET = 8;
const MENU_MAX_HEIGHT = 256;
const VIEWPORT_PADDING = 12;

interface Option<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface CustomSelectFooterAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
}

interface DropdownPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

interface CustomSelectProps<T extends string> {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  className?: string;
  footerAction?: CustomSelectFooterAction;
  /** Fired once each time the menu opens — use to lazily load options. */
  onOpen?: () => void;
}

export function CustomSelect<T extends string>({
  value,
  options,
  onChange,
  placeholder = "Select",
  className = "",
  footerAction,
  onOpen,
}: CustomSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<DropdownPosition | null>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  const updateMenuPosition = useCallback(() => {
    if (!triggerRef.current || typeof window === "undefined") return;

    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(
      Math.max(rect.width, 220),
      window.innerWidth - VIEWPORT_PADDING * 2,
    );
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, rect.left),
      Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
    );
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING;
    const spaceAbove = rect.top - VIEWPORT_PADDING;
    const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const availableHeight = Math.max(
      120,
      (openAbove ? spaceAbove : spaceBelow) - MENU_OFFSET,
    );

    setMenuPosition(
      openAbove
        ? {
            bottom: window.innerHeight - rect.top + MENU_OFFSET,
            left,
            width,
            maxHeight: Math.min(MENU_MAX_HEIGHT, availableHeight),
          }
        : {
            top: rect.bottom + MENU_OFFSET,
            left,
            width,
            maxHeight: Math.min(MENU_MAX_HEIGHT, availableHeight),
          },
    );
  }, []);

  useEffect(() => {
    const isInside = (target: EventTarget | null) => (
      target instanceof Node && (
        !!containerRef.current?.contains(target) || !!menuRef.current?.contains(target)
      )
    );

    const handleClickOutside = (event: MouseEvent) => {
      if (!isInside(event.target)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }

    updateMenuPosition();

    const handlePositionChange = () => updateMenuPosition();

    window.addEventListener("resize", handlePositionChange);
    window.addEventListener("scroll", handlePositionChange, true);

    return () => {
      window.removeEventListener("resize", handlePositionChange);
      window.removeEventListener("scroll", handlePositionChange, true);
    };
  }, [isOpen, updateMenuPosition]);

  const handleSelect = (optionValue: T) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  const handleFooterAction = () => {
    footerAction?.onClick();
    setIsOpen(false);
  };

  const dropdownMenu = isOpen && menuPosition && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={menuRef}
          role="listbox"
          className="fixed z-[10050] overflow-hidden rounded-2xl border border-border/50 bg-popover shadow-xl shadow-black/[0.08]"
          style={{
            left: menuPosition.left,
            width: menuPosition.width,
            maxHeight: menuPosition.maxHeight,
            ...(menuPosition.top !== undefined
              ? { top: menuPosition.top }
              : { bottom: menuPosition.bottom }),
          }}
        >
          <div className="max-h-full overflow-y-auto py-1.5">
            {options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handleSelect(option.value)}
                  className={`
                    w-full px-4 py-2.5 text-start flex items-center justify-between gap-2
                    text-sm transition-all duration-150
                    ${isSelected
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                    }
                  `}
                  type="button"
                >
                  <span className="flex items-center gap-2 truncate">
                    {option.icon}
                    {option.label}
                  </span>
                  {isSelected && (
                    <Check className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          {footerAction && (
            <div className="border-t border-border/50 p-1.5">
              <button
                type="button"
                onClick={handleFooterAction}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-start text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
              >
                {footerAction.icon}
                {footerAction.label}
              </button>
            </div>
          )}
        </div>,
        document.body,
      )
    : null;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Select Button */}
      <button
        ref={triggerRef}
        onClick={() => {
          if (!isOpen) onOpen?.();
          setIsOpen((prev) => !prev);
        }}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className={`
          w-full px-4 py-3 rounded-2xl text-sm font-medium
          transition-all duration-200 flex items-center justify-between gap-2
          border border-border/50
          ${isOpen 
            ? 'bg-muted/80 border-border' 
            : 'bg-muted/40 hover:bg-muted/60 hover:border-border'
          }
        `}
        type="button"
      >
        <span className="flex items-center gap-2 truncate text-foreground/70">
          {selectedOption?.icon}
          {selectedOption?.label || <span className="text-muted-foreground">{placeholder}</span>}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform duration-200 flex-shrink-0 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {dropdownMenu}
    </div>
  );
}
