"use client";

import type { ReactNode } from "react";
import { Icon } from "./icons/Icon";

interface DesktopTitleBarProps {
  labels: Record<
    "navigation" | "back" | "forward" | "minimize" | "maximize" | "restore" | "close",
    string
  >;
  mac: boolean;
  maximized: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  menu: ReactNode;
}

export function DesktopTitleBar({
  labels,
  mac,
  maximized,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onMinimize,
  onToggleMaximize,
  onClose,
  menu,
}: DesktopTitleBarProps) {
  const maximizeLabel = maximized ? labels.restore : labels.maximize;
  return (
    <header
      className="app-titlebar"
      onDoubleClick={(event) => {
        if (event.target instanceof Element && !event.target.closest("button")) onToggleMaximize();
      }}
    >
      <nav className="app-titlebar-nav" aria-label={labels.navigation}>
        <button
          type="button"
          className="app-titlebar-btn"
          onClick={onBack}
          disabled={!canGoBack}
          aria-label={labels.back}
          title={labels.back}
        >
          <Icon name="chevron-left" size={21} />
        </button>
        <button
          type="button"
          className="app-titlebar-btn"
          onClick={onForward}
          disabled={!canGoForward}
          aria-label={labels.forward}
          title={labels.forward}
        >
          <Icon name="chevron-right" size={21} />
        </button>
      </nav>
      <div className="app-titlebar-drag" />
      {!mac && (
        <div className="app-titlebar-end">
          {menu}
          <div className="app-titlebar-controls">
            <button
              type="button"
              className="app-titlebar-btn"
              onClick={onMinimize}
              aria-label={labels.minimize}
              title={labels.minimize}
            >
              <Icon name="minus" size={12} />
            </button>
            <button
              type="button"
              className="app-titlebar-btn"
              onClick={onToggleMaximize}
              aria-label={maximizeLabel}
              title={maximizeLabel}
            >
              <Icon name={maximized ? "copy" : "square"} size={12} />
            </button>
            <button
              type="button"
              className="app-titlebar-btn app-titlebar-btn--close"
              onClick={onClose}
              aria-label={labels.close}
              title={labels.close}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
