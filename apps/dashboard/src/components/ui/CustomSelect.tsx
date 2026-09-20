"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { inputVariants } from "./input";

const MENU_OFFSET = 8;
const MENU_MAX_HEIGHT = 320;
const VIEWPORT_PADDING = 12;

const SEARCH_AUTO_THRESHOLD = 8;

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
  width: number;
  maxHeight: number;
}

export interface CustomSelectProps<T extends string> {
  id?: string;
  "aria-label"?: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  className?: string;
  /** Input and filled use the shared Input appearance, with descriptions only in the menu. */
  variant?: "default" | "input" | "filled";
  footerAction?: CustomSelectFooterAction;
  /** Fired once each time the menu opens — use to lazily load options. */
  onOpen?: () => void;
  disabled?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptySearchMessage?: (query: string) => string;
  emptyMessage?: string;
  loadingMessage?: string;
  loadMoreMessage?: string;
}

export function CustomSelect<T extends string>({
  id,
  "aria-label": ariaLabel,
  value,
  options,
  onChange,
  placeholder = "Select",
  className = "",
  variant = "default",
  footerAction,
  onOpen,
  disabled = false,
  onLoadMore,
  hasMore = false,
  isLoadingMore = false,
  searchable,
  searchPlaceholder,
  emptySearchMessage,
  emptyMessage = "No matches",
  loadingMessage = "Loading...",
  loadMoreMessage = "Load more",
}: CustomSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedValue, setHighlightedValue] = useState<T>();
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const didInitialScroll = useRef(false);
  const [menuPosition, setMenuPosition] = useState<DropdownPosition | null>(null);

  const selectedOption = options.find((opt) => opt.value === value);
  const showSearch =
    searchable ?? (Boolean(searchPlaceholder) || options.length >= SEARCH_AUTO_THRESHOLD);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((opt) =>
      `${opt.label} ${opt.value} ${opt.description ?? ""}`.toLocaleLowerCase().includes(q),
    );
  }, [options, query]);

  // Loading another page can reorder options; keep keyboard focus on the same value.
  const highlight = Math.max(
    0,
    filteredOptions.findIndex((option) => option.value === highlightedValue),
  );

  const updateMenuPosition = useCallback(() => {
    if (!triggerRef.current || typeof window === "undefined") return;

    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - VIEWPORT_PADDING * 2);
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, rect.left),
      Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
    );
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING;
    const spaceAbove = rect.top - VIEWPORT_PADDING;
    const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const availableHeight = Math.max(120, (openAbove ? spaceAbove : spaceBelow) - MENU_OFFSET);

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
    const isInside = (target: EventTarget | null) =>
      target instanceof Node &&
      (!!containerRef.current?.contains(target) || !!menuRef.current?.contains(target));

    const handleClickOutside = (event: MouseEvent) => {
      if (!isInside(event.target)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
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
      setQuery("");
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

  useEffect(() => {
    if (!isOpen) {
      didInitialScroll.current = false;
      return;
    }
    if (didInitialScroll.current || !listRef.current) return;
    didInitialScroll.current = true;

    const selectedIndex = filteredOptions.findIndex((opt) => opt.value === value);
    const start = selectedIndex >= 0 ? selectedIndex : 0;
    setHighlightedValue(filteredOptions[start]?.value);
    listRef.current.querySelector(`[data-index="${start}"]`)?.scrollIntoView({ block: "nearest" });
    if (showSearch) inputRef.current?.focus();
    else listRef.current.focus();
  }, [filteredOptions, isOpen, menuPosition, showSearch, value]);

  // A filtered first page can be empty and therefore cannot trigger scrolling.
  // Keep looking through later pages until the menu has matches or reaches the end.
  useEffect(() => {
    if (
      isOpen &&
      query.trim() &&
      filteredOptions.length < SEARCH_AUTO_THRESHOLD &&
      hasMore &&
      !isLoadingMore
    ) {
      onLoadMore?.();
    }
  }, [isOpen, query, filteredOptions.length, hasMore, isLoadingMore, onLoadMore]);

  const handleSearch = (nextQuery: string) => {
    setQuery(nextQuery);
    setHighlightedValue(undefined);
    listRef.current?.scrollTo({ top: 0 });
  };

  const handleSelect = (optionValue: T) => {
    onChange(optionValue);
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleFooterAction = () => {
    footerAction?.onClick();
    setIsOpen(false);
  };

  const moveHighlight = (delta: number) => {
    if (filteredOptions.length === 0) return;
    const next = Math.min(Math.max(highlight + delta, 0), filteredOptions.length - 1);
    setHighlightedValue(filteredOptions[next].value);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent) => {
    // Buttons (including the footer action) retain their native Enter behavior.
    if (
      event.key === "Enter" &&
      event.target !== inputRef.current &&
      event.target !== listRef.current
    )
      return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filteredOptions[highlight];
      if (option) handleSelect(option.value);
    }
  };

  const handleListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!onLoadMore || !hasMore || isLoadingMore) return;
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight <= 64) onLoadMore();
  };

  const dropdownMenu =
    isOpen && menuPosition && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            onKeyDown={handleMenuKeyDown}
            className="fixed z-[10050] flex flex-col overflow-hidden rounded-2xl border border-border/50 bg-popover shadow-xl shadow-black/[0.08]"
            style={{
              left: menuPosition.left,
              width: menuPosition.width,
              maxHeight: menuPosition.maxHeight,
              ...(menuPosition.top !== undefined
                ? { top: menuPosition.top }
                : { bottom: menuPosition.bottom }),
            }}
          >
            {showSearch && (
              <div className="flex-none border-b border-border/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <input
                    ref={inputRef}
                    type="text"
                    role="combobox"
                    aria-expanded={true}
                    aria-controls={listId}
                    aria-activedescendant={
                      filteredOptions[highlight] ? `${listId}-${highlight}` : undefined
                    }
                    value={query}
                    onChange={(e) => handleSearch(e.target.value)}
                    placeholder={searchPlaceholder ?? "Search..."}
                    aria-label={searchPlaceholder ?? "Search..."}
                    className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel ?? placeholder}
              tabIndex={-1}
              onScroll={handleListScroll}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5 touch-pan-y"
            >
              {filteredOptions.length === 0 && !isLoadingMore ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">
                  {emptySearchMessage?.(query) ?? emptyMessage}
                </div>
              ) : (
                filteredOptions.map((option, index) => {
                  const isSelected = option.value === value;
                  const isHighlighted = index === highlight;
                  return (
                    <button
                      key={option.value}
                      id={`${listId}-${index}`}
                      data-index={index}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => handleSelect(option.value)}
                      onMouseEnter={() => setHighlightedValue(option.value)}
                      className={`
                      w-full px-4 py-2.5 text-start flex items-center justify-between gap-2
                      text-sm transition-all duration-150
                      ${
                        isSelected
                          ? "bg-accent text-accent-foreground font-medium"
                          : isHighlighted
                            ? "text-foreground bg-accent/50"
                            : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                      }
                    `}
                      type="button"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {option.icon}
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{option.label}</span>
                          {option.description && (
                            <span className="truncate text-xs text-muted-foreground/70">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </span>
                      {isSelected && (
                        <Check className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {hasMore && onLoadMore && !isLoadingMore && (
              <button
                type="button"
                onClick={onLoadMore}
                className="flex-none border-t border-border/50 px-4 py-2 text-sm text-muted-foreground hover:bg-accent/50"
              >
                {loadMoreMessage}
              </button>
            )}

            {isLoadingMore && (
              <div
                role="status"
                className="flex flex-none items-center justify-center gap-2 border-t border-border/50 px-4 py-2 text-xs text-muted-foreground"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {loadingMessage}
              </div>
            )}

            {footerAction && (
              <div className="flex-none border-t border-border/50 p-1.5">
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
        id={id}
        onClick={() => {
          if (disabled) return;
          if (!isOpen) onOpen?.();
          setIsOpen((prev) => !prev);
        }}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-controls={isOpen ? listId : undefined}
        aria-describedby={ariaLabel && selectedOption ? `${listId}-value` : undefined}
        className={cn(
          variant !== "default"
            ? inputVariants({ variant: variant === "filled" ? "filled" : "default" })
            : `
          w-full px-4 py-3 rounded-2xl text-sm font-medium
          transition-all duration-200 flex items-center justify-between gap-2
          border border-border/50
          ${
            disabled
              ? "bg-muted/30 opacity-60 cursor-not-allowed"
              : isOpen
                ? "bg-muted/80 border-border"
                : "bg-muted/40 hover:bg-muted/60 hover:border-border"
          }
        `,
          "items-center justify-between gap-2",
        )}
        type="button"
      >
        <span
          className={cn(
            "flex min-w-0 items-center gap-2",
            variant !== "default" ? "text-foreground" : "text-foreground/70",
          )}
        >
          {selectedOption?.icon}
          {selectedOption ? (
            <span className="flex min-w-0 flex-col text-start">
              <span id={`${listId}-value`} className="truncate">
                {selectedOption.label}
              </span>
              {variant === "default" && selectedOption.description && (
                <span className="truncate text-xs font-normal text-muted-foreground/70">
                  {selectedOption.description}
                </span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
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
