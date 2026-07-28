"use client";

import type { ReactNode } from "react";
import { useDemoMode } from "@/lib/demo-mode";

/**
 * Blurs an IP / host value when Demo mode is on (Settings → General → Demo mode),
 * so real addresses don't show in screen-shares or recordings. Off by default;
 * purely cosmetic — the value is still in the DOM, so it's not real secrecy.
 */
export function BlurIp({ children, className = "" }: { children: ReactNode; className?: string }) {
  const demoMode = useDemoMode();
  if (!demoMode) return <>{children}</>;
  return (
    <span className={`blur-[5px] select-none ${className}`} style={{ userSelect: "none" }}>
      {children}
    </span>
  );
}
