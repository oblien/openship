"use client";

import { useEffect, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/** Copy reply or code text using the dashboard's shared clipboard fallback. */
export function AssistantCopyButton({
  value,
  label,
  compact = false,
  disabled = false,
  className,
}: {
  value: string;
  label: string;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  const text = status === "copied" ? "Copied" : status === "error" ? "Couldn’t copy" : label;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={text}
      title={text}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-50",
        className,
      )}
      onClick={async () => {
        try {
          await copyText(value);
          setStatus("copied");
        } catch {
          setStatus("error");
        }
      }}
    >
      <Icon
        name={status === "copied" ? "check" : status === "error" ? "alert-circle" : "copy"}
        className="size-3.5"
      />
      {!compact && <span>{text}</span>}
      <span className="sr-only" role="status">
        {status === "idle" ? "" : text}
      </span>
    </button>
  );
}
