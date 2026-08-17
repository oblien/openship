"use client";

import { usePlatform } from "@/context/PlatformContext";
import { defaultDomainType } from "@/lib/default-domain-type";

/**
 * Operator has no Openship Cloud connection. Callers that still import
 * these hooks get a disconnected, no-op surface.
 */
export function useCloud() {
  return {
    connected: false,
    loading: false,
    requireCloud: async (_capability?: string, _opts?: { domain?: string }) => false,
    startConnect: (_capability?: string) => {},
    refresh: async () => {},
  };
}

export function useDefaultDomainType(): "free" | "custom" {
  const { hostDomain } = usePlatform();
  return defaultDomainType(Boolean(hostDomain));
}

export function CloudProvider({ children }: { children: React.ReactNode }) {
  return children;
}
