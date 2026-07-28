"use client";

import React, { createContext, useContext, useState, useCallback } from "react";
import { CLOUD_DASHBOARD_URL, CLOUD_API_URL } from "@repo/core";

/** Default cloud domain - matches SYSTEM.DOMAINS.CLOUD_DOMAIN in @repo/core */
const DEFAULT_CLOUD_DOMAIN = "opsh.io";

/* ── Types ────────────────────────────────────────────────────────── */

interface PlatformContextValue {
  selfHosted: boolean;
  deployMode: string;
  /** OpenShip runs ON a server (self-hosted, non-desktop): the host is itself a
   *  deployable target, auto-registered as the isLocal "This Server". */
  isServerHost: boolean;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  cloudApiUrl: string;
  machineName?: string;
  hostDomain?: string;
  /** Resolved base domain - hostDomain or the default cloud domain */
  baseDomain: string;
  setSelfHosted: (v: boolean) => void;
}

const PlatformContext = createContext<PlatformContextValue | undefined>(undefined);

type CloudConnectionPlatformState = Pick<PlatformContextValue, "selfHosted" | "deployMode">;

export function canUseCloudConnection({
  selfHosted,
  deployMode,
}: CloudConnectionPlatformState) {
  return selfHosted || deployMode === "desktop";
}

export function usePlatform() {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error("usePlatform must be used within PlatformProvider");
  return ctx;
}

/* ── Provider ─────────────────────────────────────────────────────── */

interface PlatformProviderProps {
  children: React.ReactNode;
  selfHosted?: boolean;
  deployMode?: string;
  isServerHost?: boolean;
  authMode?: "cloud" | "local" | "none";
  cloudAuthUrl?: string;
  cloudApiUrl?: string;
  machineName?: string;
  hostDomain?: string;
}

/**
 * Drives the platform context off SSR-passed props directly — only the
 * mutable `selfHosted` toggle (used by the onboarding flow) needs
 * local state. Previously every prop was frozen via `useState` at
 * first mount, so a stale `cloudAuthUrl` from a one-off bad SSR latched
 * for the SPA's lifetime. Now a fresh SSR (e.g. after the
 * `_deploymentInfo` cache TTLs) always wins.
 */
export function PlatformProvider({
  children,
  selfHosted: initialSelfHosted = true,
  deployMode = "docker",
  isServerHost = false,
  authMode = "local",
  cloudAuthUrl = CLOUD_DASHBOARD_URL,
  cloudApiUrl = CLOUD_API_URL,
  machineName,
  hostDomain,
}: PlatformProviderProps) {
  const [selfHosted, setSelfHostedState] = useState(initialSelfHosted);
  const baseDomain = hostDomain || DEFAULT_CLOUD_DOMAIN;
  const setSelfHosted = useCallback((v: boolean) => setSelfHostedState(v), []);

  return (
    <PlatformContext.Provider
      value={{
        selfHosted,
        deployMode,
        isServerHost,
        authMode,
        cloudAuthUrl,
        cloudApiUrl,
        machineName,
        hostDomain,
        baseDomain,
        setSelfHosted,
      }}
    >
      {children}
    </PlatformContext.Provider>
  );
}
