"use client";

import React, { createContext, useContext, useState, useCallback } from "react";
import { CLOUD_DASHBOARD_URL, CLOUD_API_URL } from "@repo/core";
import {
  clearProductViewCookie,
  type ProductView,
  writeProductViewCookie,
} from "@/lib/product-view";

/** Default cloud domain - matches SYSTEM.DOMAINS.CLOUD_DOMAIN in @repo/core */
const DEFAULT_CLOUD_DOMAIN = "opsh.io";

/* ── Types ────────────────────────────────────────────────────────── */

interface PlatformContextValue {
  selfHosted: boolean;
  deployMode: string;
  /** OpenShip runs ON a server (self-hosted, non-desktop): the host is itself a
   *  deployable target, auto-registered as the isLocal "This Server". */
  isServerHost: boolean;
  /** Whether the box is a deploy target for ITSELF right now (#527 runtime
   *  toggle). isServerHost is fixed by DEPLOY_MODE; this tracks the operator's
   *  Settings choice, so the "Add this machine" affordance reflects the live
   *  state without a restart. */
  hostControlEnabled: boolean;
  authMode: "cloud" | "local" | "none";
  /** Running server release reported by /health/env. */
  version?: string;
  /** What the INSTANCE declares it is (from /health/env). Used by the settings
   *  toggle to show the operator what the box-wide default currently is. */
  productMode: ProductView;
  /** What THIS user sees: `productMode` plus their cookie override. Read this,
   *  not `productMode`, to decide what to render. */
  productView: ProductView;
  /** Set the per-user override. Writes the cookie and reloads — the rail, the
   *  brand name and the document title all come from the server render, so
   *  local state alone would leave them stale. */
  setProductView: (v: ProductView) => void;
  /** Remove the override and follow `productMode` again. */
  clearProductView: () => void;
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

export function canUseCloudConnection({ selfHosted, deployMode }: CloudConnectionPlatformState) {
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
  hostControlEnabled?: boolean;
  authMode?: "cloud" | "local" | "none";
  version?: string;
  productMode?: ProductView;
  productView?: ProductView;
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
  hostControlEnabled = false,
  authMode = "local",
  version,
  productMode = "platform",
  productView = "platform",
  cloudAuthUrl = CLOUD_DASHBOARD_URL,
  cloudApiUrl = CLOUD_API_URL,
  machineName,
  hostDomain,
}: PlatformProviderProps) {
  const [selfHosted, setSelfHostedState] = useState(initialSelfHosted);
  const baseDomain = hostDomain || DEFAULT_CLOUD_DOMAIN;
  const setSelfHosted = useCallback((v: boolean) => setSelfHostedState(v), []);

  // No local state for productView on purpose: it's resolved in the server
  // layout, so the cookie IS the state — a second copy here would let the two
  // disagree after a navigation.
  //
  // Reload rather than router.refresh(): the proxy injects the cookie as a
  // request header for the layout to read, and the brand name + <title> come
  // from the root layout's metadata, so the whole document has to re-render.
  // (This also keeps useRouter out of the provider, which is mounted bare in
  // unit tests with no App Router — useRouter throws there.)
  const setProductView = useCallback((v: ProductView) => {
    writeProductViewCookie(v);
    window.location.reload();
  }, []);

  /** Drop the override and follow the instance default again. */
  const clearProductView = useCallback(() => {
    clearProductViewCookie();
    window.location.reload();
  }, []);

  return (
    <PlatformContext.Provider
      value={{
        selfHosted,
        deployMode,
        isServerHost,
        hostControlEnabled,
        authMode,
        version,
        productMode,
        productView,
        setProductView,
        clearProductView,
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
