"use client";

import React, { createContext, useContext, useState, useCallback } from "react";

/* ── Types ────────────────────────────────────────────────────────── */

interface PlatformContextValue {
  selfHosted: boolean;
  deployMode: string;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  machineName?: string;
  hostDomain?: string;
  setSelfHosted: (v: boolean) => void;
}

const PlatformContext = createContext<PlatformContextValue | undefined>(undefined);

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
  authMode?: "cloud" | "local" | "none";
  cloudAuthUrl?: string;
  machineName?: string;
  hostDomain?: string;
}

export function PlatformProvider({
  children,
  selfHosted: initialSelfHosted = true,
  deployMode: initialDeployMode = "docker",
  authMode: initialAuthMode = "local",
  cloudAuthUrl: initialCloudAuthUrl = "",
  machineName: initialMachineName,
  hostDomain: initialHostDomain,
}: PlatformProviderProps) {
  const [selfHosted, setSelfHostedState] = useState(initialSelfHosted);
  const [deployMode] = useState(initialDeployMode);
  const [authMode] = useState(initialAuthMode);
  const [cloudAuthUrl] = useState(initialCloudAuthUrl);
  const [machineName] = useState(initialMachineName);
  const [hostDomain] = useState(initialHostDomain);

  const setSelfHosted = useCallback((v: boolean) => setSelfHostedState(v), []);

  return (
    <PlatformContext.Provider
      value={{
        selfHosted,
        deployMode,
        authMode,
        cloudAuthUrl,
        machineName,
        hostDomain,
        setSelfHosted,
      }}
    >
      {children}
    </PlatformContext.Provider>
  );
}
