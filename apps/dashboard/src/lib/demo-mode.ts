import { useSyncExternalStore } from "react";

/**
 * Demo mode — a per-browser toggle that blurs IPs / hosts across the dashboard
 * for screen-shares, recordings, and live demos. Purely cosmetic + client-side
 * (localStorage), so it's off by default and never touches the server. Consumed
 * by <BlurIp> and toggled from Settings → General → Demo mode.
 */
const KEY = "openship:demo-mode";
const EVENT = "openship:demo-mode-change";

function read(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Turn demo mode on/off; notifies every <BlurIp> live (and other tabs). */
export function setDemoMode(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode / storage disabled — ignore */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange); // cross-tab sync
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Reactive read — re-renders when demo mode flips (this tab or another). */
export function useDemoMode(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
