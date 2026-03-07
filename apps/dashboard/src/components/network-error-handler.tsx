"use client";

import { useEffect } from "react";
import { setNetworkErrorHandler } from "@/lib/api/client";
import { useToast } from "@/components/toast";

/**
 * Mounts once in the root layout and registers a global handler so that any
 * API call that fails at the network level (server down, ECONNREFUSED, timeout)
 * automatically shows a toast — without needing per-call error handling.
 */
export function NetworkErrorHandler() {
  const { toast } = useToast();

  useEffect(() => {
    setNetworkErrorHandler((msg) => {
      toast("error", msg);
    });

    return () => {
      // Clear the handler when this component unmounts
      setNetworkErrorHandler(null);
    };
  }, [toast]);

  return null;
}
