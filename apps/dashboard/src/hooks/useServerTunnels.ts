"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { systemApi } from "@/lib/api";
import type { TunnelInfo } from "@/lib/api/system";

const POLL_MS = 4000;

/**
 * The single client-side source of truth for a server's saved port-forwards.
 *
 * Fetches `server_tunnels` (config + live status) and polls every 4s. Both the
 * server-detail "Ports" tab badge (a count that must show even when the card
 * isn't mounted) and the `PortForwardingCard` list read from one instance of
 * this hook, so the two can't drift or double-poll. Mutations still go through
 * `systemApi.*` directly; callers invoke `refresh()` afterwards.
 *
 * No-ops (empty list, no polling) when `serverId` is null — e.g. non-desktop
 * deployments where the feature is gated off.
 */
export function useServerTunnels(serverId: string | null | undefined) {
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [loading, setLoading] = useState(!!serverId);

  // Avoid setState after unmount during polling.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!serverId) {
        setTunnels([]);
        setLoading(false);
        return;
      }
      if (!opts.silent) setLoading(true);
      try {
        const rows = await systemApi.listTunnels(serverId);
        if (mounted.current) setTunnels(rows);
      } catch {
        // Silent on poll; keep the last good state.
      } finally {
        if (mounted.current && !opts.silent) setLoading(false);
      }
    },
    [serverId],
  );

  useEffect(() => {
    if (!serverId) {
      setTunnels([]);
      setLoading(false);
      return;
    }
    void refresh();
    const t = setInterval(() => void refresh({ silent: true }), POLL_MS);
    return () => clearInterval(t);
  }, [serverId, refresh]);

  return { tunnels, loading, refresh };
}
