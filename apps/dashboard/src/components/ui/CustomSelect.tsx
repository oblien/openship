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
  /** Optional dimmed second line under the label (domain, host, hint …). */
  description?: string;
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
  width?: number;
  minWidth?: number;
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
  disabled?: boolean;
  /** Compact trigger for inline field prefixes. */
  size?: "default" | "compact";
  ariaLabel?: string;
}

export function CustomSelect<T extends string>({
  value,
  options,
  onChange,
  placeholder = "Select",
  className = "",
  footerAction,
  onOpen,
  disabled = false,
  size = "default",
  ariaLabel,
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
    const minWidth = size === "compact" ? rect.width : 220;
    const width = size === "compact"
      ? undefined
      : Math.min(
          Math.max(rect.width, minWidth),
          window.innerWidth - VIEWPORT_PADDING * 2,
        );
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, rect.left),
      Math.max(
        VIEWPORT_PADDING,
        window.innerWidth - (width ?? Math.max(rect.width, 160)) - VIEWPORT_PADDING,
      ),
    );
    const offset = size === "compact" ? 4 : MENU_OFFSET;
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING;
    const spaceAbove = rect.top - VIEWPORT_PADDING;
    const minMenu = size === "compact" ? 72 : 120;
    const openAbove = spaceBelow < minMenu && spaceAbove > spaceBelow;
    const availableHeight = Math.max(
      minMenu,
      (openAbove ? spaceAbove : spaceBelow) - offset,
    );

    setMenuPosition(
      openAbove
        ? {
            bottom: window.innerHeight - rect.top + offset,
            left,
            width,
            minWidth,
            maxHeight: Math.min(MENU_MAX_HEIGHT, availableHeight),
          }
        : {
            top: rect.bottom + offset,
            left,
            width,
            minWidth,
            maxHeight: Math.min(MENU_MAX_HEIGHT, availableHeight),
          },
    );
  }, [size]);

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
          className={`fixed z-[10050] border border-border bg-popover shadow-lg shadow-black/[0.06] ${
            size === "compact"
              ? "h-fit w-max rounded-lg"
              : "overflow-hidden rounded-2xl border-border/50 shadow-xl shadow-black/[0.08]"
          }`}
          style={{
            left: menuPosition.left,
            minWidth: menuPosition.minWidth,
            ...(menuPosition.width !== undefined ? { width: menuPosition.width } : {}),
            ...(size === "compact" ? undefined : { maxHeight: menuPosition.maxHeight }),
            ...(menuPosition.top !== undefined
              ? { top: menuPosition.top }
              : { bottom: menuPosition.bottom }),
          }}
        >
          <div
            className={size === "compact" ? "flex flex-col p-0.5" : "overflow-y-auto py-1.5"}
            style={size === "compact" ? undefined : { maxHeight: menuPosition.maxHeight }}
          >
            {options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handleSelect(option.value)}
                  className={`
                    w-full text-start flex items-center justify-between gap-2
                    transition-all duration-150
                    ${size === "compact" ? "h-8 rounded-md px-2.5 text-[13px] leading-none" : "px-4 py-2.5 text-sm"}
                    ${isSelected
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                    }
                  `}
                  type="button"
                >
                  <span className={`flex items-center gap-2 ${option.description ? "min-w-0" : "shrink-0"}`}>
                    {option.icon}
                    {option.description ? (
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{option.label}</span>
                        <span className="truncate text-xs text-muted-foreground/70">
                          {option.description}
                        </span>
                      </span>
                    ) : (
                      <span className="whitespace-nowrap">{option.label}</span>
                    )}
                  </span>
                  <Check
                    className={`size-3.5 shrink-0 ${isSelected ? "text-muted-foreground" : "invisible"}`}
                  />
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
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className={
          size === "compact"
            ? `flex h-full items-center gap-1 px-2.5 text-[13px] font-medium text-foreground transition-colors ${
                disabled ? "cursor-not-allowed opacity-50" : "hover:bg-foreground/[0.04]"
              } ${isOpen ? "bg-foreground/[0.04]" : ""}`
            : `
          w-full px-4 py-3 rounded-2xl text-sm font-medium
          transition-all duration-200 flex items-center justify-between gap-2
          border border-border/50
          ${disabled ? "cursor-not-allowed opacity-50" : ""}
          ${isOpen 
            ? 'bg-muted/80 border-border' 
            : 'bg-muted/40 hover:bg-muted/60 hover:border-border'
          }
        `
        }
        type="button"
      >
        <span className={`flex min-w-0 items-center gap-2 ${size === "compact" ? "text-foreground" : "text-foreground/70"}`}>
          {selectedOption?.icon}
          {selectedOption ? (
            selectedOption.description ? (
              <span className="flex min-w-0 flex-col text-start">
                <span className="truncate">{selectedOption.label}</span>
                <span className="truncate text-xs font-normal text-muted-foreground/70">
                  {selectedOption.description}
                </span>
              </span>
            ) : (
              <span className="truncate">{selectedOption.label}</span>
            )
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        <ChevronDown
          className={`text-muted-foreground transition-transform duration-200 flex-shrink-0 ${
            size === "compact" ? "size-3.5" : "w-4 h-4"
          } ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {dropdownMenu}
    </div>
  );
}
