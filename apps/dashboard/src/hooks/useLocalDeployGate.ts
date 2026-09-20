"use client";

// TODO: temporary desktop gate. Desktop mode is built to CONTROL remote servers;
// running the workload on the desktop itself isn't enabled yet. Flip
// DESKTOP_LOCAL_DEPLOY_ENABLED to true (one line) to turn the whole gate off —
// then delete this hook, LocalDeployComingSoonModal, and the call sites.

import { useCallback, useEffect, useState } from "react";
import { systemApi } from "@/lib/api";
import { usePlatform } from "@/context/PlatformContext";

/** The single switch. `true` → the gate disappears everywhere at once. */
export const DESKTOP_LOCAL_DEPLOY_ENABLED = false;

interface Destination {
  deployTarget?: string | null;
  serverId?: string | null;
}

export interface LocalDeployGate {
  /** Desktop mode, and local deploys are still disabled. */
  isDesktop: boolean;
  /** True once the server list has resolved — `blocks()` is only reliable then. */
  ready: boolean;
  /**
   * Would this destination run the workload on the desktop itself?
   *
   * Two shapes count as "this machine": the explicit `local` target, and the
   * auto-registered `isLocal` server row (a deploy to it runs on this host, so
   * picking it from the server list is the same thing by another name).
   */
  blocks: (dest: Destination) => boolean;
}

/**
 * Is a chosen deploy destination the desktop itself, on a build where that isn't
 * allowed yet?
 *
 * Deliberately says nothing about BUILDING locally — the desktop stays a valid
 * build destination (it has the source). Only the deploy destination is gated.
 */
export function useLocalDeployGate(): LocalDeployGate {
  const { deployMode } = usePlatform();
  const isDesktop = deployMode === "desktop" && !DESKTOP_LOCAL_DEPLOY_ENABLED;

  const [localServerIds, setLocalServerIds] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isDesktop) {
      setReady(true);
      return;
    }
    let cancelled = false;
    systemApi
      .listServers()
      .then((list) => {
        if (cancelled) return;
        setLocalServerIds(new Set(list.filter((s) => s.isLocal).map((s) => s.id)));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  const blocks = useCallback(
    (dest: Destination) => {
      if (!isDesktop) return false;
      if (dest.deployTarget === "local") return true;
      return dest.deployTarget === "server" && !!dest.serverId && localServerIds.has(dest.serverId);
    },
    [isDesktop, localServerIds],
  );

  return { isDesktop, ready, blocks };
}
