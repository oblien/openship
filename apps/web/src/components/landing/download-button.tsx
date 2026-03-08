"use client";

import { useEffect, useRef, useState } from "react";
import { usePlatform, type Platform } from "@/hooks/use-platform";

/* ── Platform icons ── */
function AppleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  );
}

function LinuxIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.368 1.884 1.43.868.07 1.678-.467 1.975-1.484.1-.334.204-.669.305-1.004.2-.668.398-1.335.554-2 .156-.668.297-1.338.378-2.004a2.08 2.08 0 00-.193-1.2c.4-.748.757-1.336.914-2.007.199-.869.099-1.87-.399-3.003-.564-1.332-1.272-2.8-1.743-4.287-.216-.668-.39-1.314-.428-2.008-.05-.87.154-1.868.473-2.865.32-.998.721-2.093.66-3.202C18.108.784 16.985 0 15.595 0h-.003c-.578.002-1.129.2-1.597.468a4.534 4.534 0 00-1.482 1.196c-.012.016-.018.019-.03.019z" />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  );
}

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  apple: AppleIcon,
  windows: WindowsIcon,
  linux: LinuxIcon,
  download: DownloadIcon,
};

/* ── Dropdown items ── */
const DROPDOWN_PLATFORMS: { platform: Platform; label: string; icon: string }[] = [
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
  const { downloadUrl, icon, platform, getDownloadUrl } = usePlatform();
  const Icon = ICON_MAP[icon];
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

  const sizeClasses =
    size === "large" ? "py-3 text-[15px]" : "py-2.5 text-[14px]";

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
        <Icon className="h-[20px] w-[20px]" />
        <span>Download</span>
      </a>

      {/* Dropdown toggle */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${btnBase} px-2 rounded-l-none border-l border-l-white/20 flex items-center`}
        aria-label="Other platforms"
      >
        <ChevronIcon className={`h-3.5 w-3.5 transition-transform mr-2 ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Dropdown menu */}
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-[9999] min-w-[200px] overflow-hidden rounded-xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] shadow-[0_12px_40px_rgba(0,0,0,.12)]">
          <p className="px-3.5 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] th-text-muted">
            All platforms
          </p>
          {DROPDOWN_PLATFORMS.map((p) => {
            const PIcon = ICON_MAP[p.icon];
            const isCurrent = p.platform === platform;
            return (
              <a
                key={p.platform}
                href={getDownloadUrl(p.platform)}
                className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] font-medium transition-colors hover:bg-[var(--th-sf-02)] th-text-heading"
                onClick={() => setOpen(false)}
              >
                <PIcon className="h-4 w-4 th-text-secondary" />
                {p.label}
                {isCurrent && (
                  <span className="ml-auto rounded-full bg-[var(--th-accent-violet)] px-2 py-0.5 text-[10px] font-bold text-white">
                    Detected
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
