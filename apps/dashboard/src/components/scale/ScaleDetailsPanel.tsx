"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ResourceIcon } from "./ResourceIcon";
import type { ResourceKind } from "./topology";

interface ScaleDetailsPanelProps {
  title: string;
  summary?: string;
  kind: ResourceKind;
  icon?: ReactNode;
  connectionPreview?: {
    content: ReactNode;
    description: string;
    onRemove?: () => void;
  };
  /** Omit for a details panel that opens directly and closes without a preview. */
  open?: boolean;
  onOpen?: () => void;
  onMinimize?: () => void;
  onClose: () => void;
  onBack?: () => void;
  children: ReactNode;
}

export function ScaleDetailsPanel({
  title,
  summary,
  kind,
  icon,
  connectionPreview,
  open = true,
  onOpen,
  onMinimize,
  onClose,
  onBack,
  children,
}: ScaleDetailsPanelProps) {
  const id = useId();
  const [hasOpened, setHasOpened] = useState(open);
  // Capture before opening makes the diagram inert and moves browser focus.
  const [trigger] = useState(() => typeof document === "undefined" ? null : document.activeElement);
  const panelRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const previouslyOpen = useRef(false);

  useEffect(() => {
    return () => {
      if ((trigger instanceof HTMLElement || trigger instanceof SVGElement) && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [trigger]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const workspace = preview?.closest<HTMLElement>(".scale-workspace");
    if (open || !preview || !workspace) return;
    const measure = () =>
      workspace.style.setProperty("--scale-preview-height", `${preview.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    return () => {
      observer.disconnect();
      workspace.style.removeProperty("--scale-preview-height");
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setHasOpened(true);
      panelRef.current?.focus({ preventScroll: true });
    } else if (previouslyOpen.current) {
      launcherRef.current?.focus({ preventScroll: true });
    }
    previouslyOpen.current = open;
  }, [open]);

  return (
    <>
      {!open && (
        <div
          ref={previewRef}
          className="scale-inspector-launcher scale-resource-tone scale-floating-surface rounded-2xl border border-border/60"
          data-kind={kind}
        >
          <div
            className={
              connectionPreview ? "flex items-center gap-3 px-4 py-3" : "flex items-center p-5"
            }
          >
            {connectionPreview ? (
              <>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                  {icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-sm font-medium text-foreground"
                    title={title}
                  >
                    {title}
                  </span>
                  <span
                    className="mt-0.5 block truncate text-xs text-muted-foreground"
                    title={connectionPreview.description}
                  >
                    {connectionPreview.description}
                  </span>
                </span>
              </>
            ) : (
              <button
                ref={launcherRef}
                type="button"
                className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl text-start focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={`Expand settings for ${title}`}
                aria-expanded={false}
                aria-controls={id}
                onClick={onOpen}
              >
                <span
                  className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${icon ? "bg-muted/60 text-muted-foreground" : "scale-resource-icon"}`}
                >
                  {icon ?? <ResourceIcon kind={kind} className="size-5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-sm font-medium text-foreground"
                    title={title}
                  >
                    {title}
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {summary ?? "Expand settings"}
                  </span>
                </span>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors group-hover:bg-muted/60 group-hover:text-foreground">
                  <UiIcon name="chevron-down" className="size-4" />
                </span>
              </button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={onClose}
              aria-label="Clear selection"
              title="Clear selection"
            >
              <UiIcon name="close" />
            </Button>
          </div>
          {connectionPreview && (
            <>
              {connectionPreview.content}
              <div className="flex items-center gap-2 px-4 py-3">
                <Button
                  ref={launcherRef}
                  variant="outline"
                  size="sm"
                  className="flex-1 bg-muted/50 text-foreground"
                  aria-label={`Expand settings for ${title}`}
                  aria-expanded={false}
                  aria-controls={id}
                  onClick={onOpen}
                >
                  <UiIcon name="settings" />
                  Settings
                </Button>
                {connectionPreview.onRemove && <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-danger"
                  aria-label="Remove connection"
                  onClick={connectionPreview.onRemove}
                >
                  <UiIcon name="unplug" />
                  Remove
                </Button>}
              </div>
            </>
          )}
        </div>
      )}
      <div
        ref={panelRef}
        id={id}
        hidden={!open}
        role="region"
        aria-label={`${title} settings`}
        tabIndex={-1}
        className="scale-inspector-overlay scale-floating-surface overflow-hidden rounded-2xl border border-border/60 outline-none"
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !event.defaultPrevented &&
            !document.querySelector('[role="listbox"]')
          ) {
            event.preventDefault();
            event.stopPropagation();
            (onMinimize ?? onClose)();
          }
        }}
      >
        {(open || hasOpened) && (
          <div className="flex h-full flex-col">
            {onBack && (
              <div className="shrink-0 border-b border-border/50 px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-muted-foreground"
                  onClick={onBack}
                >
                  <UiIcon name="arrow-left" className="rtl:rotate-180" />
                  Back to overview
                </Button>
              </div>
            )}
            <div className="min-h-0 flex-1">{children}</div>
          </div>
        )}
      </div>
    </>
  );
}
