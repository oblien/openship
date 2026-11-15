"use client";
import { useCopy } from "@/i18n/use-copy";

import { useEffect, useRef, useState } from "react";
import { usePlatform, type Platform, type PlatformInfo } from "@/hooks/use-platform";
import { PlatformIcon } from "@/components/platform-icon";

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  );
}

/* ── Dropdown items ── */
const DROPDOWN_PLATFORMS: { platform: Platform; label: string; icon: PlatformInfo["icon"] }[] = [
  { platform: "mac-arm", label: "Mac (Apple Silicon)", icon: "apple" },
  { platform: "mac-intel", label: "Mac (Intel)", icon: "apple" },
  { platform: "windows", label: "Windows", icon: "windows" },
  { platform: "linux", label: "Linux", icon: "linux" },
];

/* ── Props ── */
interface DownloadButtonProps {
  /** Visual variant */
  variant?: "primary" | "ghost";
  /** Additional classes */
  className?: string;
  /** Size */
  size?: "default" | "large";
}

export function DownloadButton({
  variant = "primary",
  className = "",
  size = "default",
}: DownloadButtonProps) {
  const copy = useCopy();

  const { downloadUrl, icon, platform, getDownloadUrl } = usePlatform();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const sizeClasses = size === "large" ? "py-3 text-[15px]" : "py-2.5 text-[14px]";

  const btnBase =
    variant === "primary"
      ? `th-btn rounded-full font-medium ${sizeClasses}`
      : `th-btn-ghost rounded-full font-medium ${sizeClasses}`;

  return (
    <div ref={ref} className={`relative inline-flex ${className}`}>
      {/* Main download link */}
      <a
        href={downloadUrl}
        className={`${btnBase} pl-5 pr-3 flex items-center gap-2 rounded-r-none border-r-0`}
      >
        <PlatformIcon name={icon} className="h-[20px] w-[20px]" />
        <span>{copy("Download")}</span>
      </a>

      {/* Dropdown toggle */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${btnBase} px-2 rounded-l-none border-l border-l-white/20 flex items-center`}
        aria-label={copy("Other platforms")}
      >
        <ChevronIcon
          className={`h-3.5 w-3.5 transition-transform mr-2 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown menu */}
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-[9999] min-w-[200px] overflow-hidden rounded-xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] shadow-[0_12px_40px_rgba(0,0,0,.12)]">
          <p className="px-3.5 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] th-text-muted">
            {copy("All platforms")}
          </p>
          {DROPDOWN_PLATFORMS.map((p) => {
            const isCurrent = p.platform === platform;
            return (
              <a
                key={p.platform}
                href={getDownloadUrl(p.platform)}
                className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] font-medium transition-colors hover:bg-[var(--th-sf-02)] th-text-heading"
                onClick={() => setOpen(false)}
              >
                <PlatformIcon name={p.icon} className="h-4 w-4 th-text-secondary" />
                {copy(p.label)}
                {isCurrent && (
                  <span className="ml-auto rounded-full bg-[var(--th-accent-violet)] px-2 py-0.5 text-[10px] font-bold text-white">
                    {copy("Detected")}
                  </span>
                )}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
