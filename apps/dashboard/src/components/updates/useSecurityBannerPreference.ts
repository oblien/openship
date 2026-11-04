"use client";

import { useCallback, useSyncExternalStore } from "react";
import { reportCaughtError } from "@repo/core/diagnostics";
import { useCloudResourceKey } from "@/context/CloudResourceContext";

const listeners = new Set<() => void>();
const sessionPreferences = new Map<string, boolean>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Visibility is a browser/account preference; security checks and delivery stay independent. */
export function useSecurityBannerPreference() {
  const resourceKey = useCloudResourceKey();
  const key = `openship_security_banners:${resourceKey}`;
  const snapshot = useCallback(() => {
    if (sessionPreferences.has(key)) return sessionPreferences.get(key)!;
    try {
      return localStorage.getItem(key) !== "0";
    } catch (error) {
      sessionPreferences.set(key, true);
      reportCaughtError(error, "updates/security-banner-preference");
      return true;
    }
  }, [key]);
  const enabled = useSyncExternalStore(subscribe, snapshot, () => true);
  const setEnabled = useCallback(
    (value: boolean) => {
      try {
        localStorage.setItem(key, value ? "1" : "0");
        sessionPreferences.delete(key);
      } catch (error) {
        sessionPreferences.set(key, value);
        reportCaughtError(error, "updates/security-banner-preference");
      }
      for (const listener of listeners) listener();
    },
    [key],
  );
  return { enabled, setEnabled };
}
