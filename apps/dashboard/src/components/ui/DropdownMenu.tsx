"use client";

import React, { useState, useRef, useEffect } from "react";
import { MoreHorizontal } from "lucide-react";

export interface MenuAction {
  id: string;
  /** Omit `label` (and `onClick`) to render a pure horizontal divider row. */
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  variant?: "default" | "danger" | "success" | "warning";
  disabled?: boolean;
  /** Render a horizontal rule after this item (or as this item when `label` is omitted). */
  divider?: boolean;
}

interface DropdownMenuProps {
  actions: MenuAction[];
  trigger?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
  triggerClassName?: string;
  disabled?: boolean;
}

const DropdownMenu: React.FC<DropdownMenuProps> = ({
  actions,
  trigger,
  align = "right",
  className = "",
  triggerClassName = "",
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
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

  const handleActionClick = (action: MenuAction) => {
    if (!action.disabled && action.onClick) {
      action.onClick();
      setIsOpen(false);
    }
  };

  const getVariantStyles = (variant: MenuAction["variant"]) => {
    switch (variant) {
      case "danger":
        return {
          color: "#ef4444",
          hoverBg: "rgba(239, 68, 68, 0.08)",
        };
      case "success":
        return {
          color: "#10b981",
          hoverBg: "rgba(16, 185, 129, 0.08)",
        };
      case "warning":
        return {
          color: "#f59e0b",
          hoverBg: "rgba(245, 158, 11, 0.08)",
        };
      default:
        return {
          color: "#1f2937",
          hoverBg: "rgba(0, 0, 0, 0.04)",
        };
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger Button */}
      <button
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`${triggerClassName ||
          `p-2 rounded-lg transition-all duration-200 ${
            disabled
              ? "opacity-50 cursor-not-allowed"
              : "hover:bg-muted active:bg-muted/80"
          }`
        }`}
        type="button"
        style={{
          backgroundColor: isOpen && !triggerClassName ? "hsl(var(--muted))" : undefined,
        }}
      >
        {trigger || <MoreHorizontal className="w-4 h-4 text-muted-foreground" />}
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          className={`absolute z-50 mt-2 bg-card border border-border/50 rounded-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 ${align === "right" ? "right-0" : "left-0"
            }`}
          style={{
            minWidth: "220px",
            boxShadow: "0 20px 40px rgba(0, 0, 0, 0.12), 0 4px 8px rgba(0, 0, 0, 0.06)",
          }}
        >
          <div className="py-2 px-2 flex flex-col">
            {actions.map((action, index) => {
              // Pure divider row — no button, just a line
              if (!action.label && action.divider) {
                return <div key={action.id} className="my-2 mx-3 border-t border-border/50" />;
              }

              const styles = getVariantStyles(action.variant);
              const iconString = typeof action.icon === 'string' ? action.icon : undefined;

              return (
                <React.Fragment key={action.id}>
                  <button
                    onClick={() => handleActionClick(action)}
                    disabled={action.disabled}
                    className={`w-full hover:bg-muted active:bg-muted/80 px-3 py-3 text-left flex items-center gap-3 transition-all duration-200 rounded-xl ${action.disabled
                        ? "opacity-50 cursor-not-allowed"
                        : "cursor-pointer"
                      }`}
                    type="button"
                    style={{
                      color: action.disabled ? "hsl(var(--muted-foreground))" : styles.color,
                    }}
                  >
                    {action.icon && (
                      <div className="icon-wrapper w-5 h-5 flex items-center justify-center flex-shrink-0 transition-transform duration-200">
                        {action.icon}
                      </div>
                    )}
                    <span className="text-[14px] font-medium truncate">
                      {action.label}
                    </span>
                  </button>
                  {action.divider && index < actions.length - 1 && (
                    <div className="my-2 mx-3 border-t border-border/50" />
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default DropdownMenu;
