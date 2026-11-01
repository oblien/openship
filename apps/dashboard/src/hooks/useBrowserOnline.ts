"use client";

import { useSyncExternalStore } from "react";

function subscribe(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/** Browser connectivity is a UI hint, never a verdict about a remote server. */
export function useBrowserOnline() {
  return useSyncExternalStore(subscribe, () => navigator.onLine !== false, () => true);
}
