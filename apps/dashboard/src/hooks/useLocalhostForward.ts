"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useCallback } from "react";
import { systemApi } from "@/lib/api";
import { usePlatform } from "@/context/PlatformContext";
import { useToast } from "@/context/ToastContext";

/**
 * Port-forward a remote server or container port onto this machine over the
 * existing SSH tunnel, then open (or copy) `http://localhost:<localPort>`.
 *
 * This is the one place the `saveTunnel → startTunnel → open` sequence lives:
 * the connection card's per-value "Open on localhost" action and the no-route
 * "Open" affordances (project sidebar + Domains cold card) all call it, so the
 * gate and the plumbing can't drift between them.
 *
 * The listener runs on the Desktop API's machine, so automatic forwarding is
 * offered only by Desktop managing an SSH server. Public exposure is unrelated:
 * private services can use their live container address as `remoteHost`.
 */
export function useLocalhostForward({
  serverId,
  deployTarget,
}: {
  serverId?: string | null;
  deployTarget?: string | null;
}) {
  const { deployMode } = usePlatform();
  const { showToast } = useToast();

  const canForward = deployMode === "desktop" && deployTarget === "server" && !!serverId;

  // Forward `remotePort` and either pop a browser tab ("open") or copy the local
  // URL ("copy" — for values with nowhere to open, e.g. a driver URL). Returns
  // the local URL, or null on failure (a toast is shown). No in-flight state is
  // held here on purpose: each caller owns its own spinner, so one card's forward
  // doesn't visually block another's.
  const forward = useCallback(
    async (
      remotePort: number,
      action: "open" | "copy" = "open",
      remoteHost?: string,
    ): Promise<string | null> => {
      if (!canForward || !serverId || !remotePort) return null;
      try {
        const saved = await systemApi.saveTunnel(serverId, {
          remotePort,
          ...(remoteHost ? { remoteHost } : {}),
        });
        const started = await systemApi.startTunnel(serverId, saved.id);
        const url = started.url ?? (started.localPort ? `http://localhost:${started.localPort}` : null);
        if (!url) return null;
        // The forward is now a managed row (visible + controllable under the
        // server's Ports tab); toast so it doesn't read as a throwaway action.
        const localLabel = url.replace(/^https?:\/\//, "");
        if (action === "open") {
          window.open(url, "_blank", "noopener");
          showToast(`Forwarding remote port ${remotePort} → ${localLabel}`, "success");
        } else {
          await navigator.clipboard.writeText(url).catch((diagnosticFailure) => {
            observeCaughtError(diagnosticFailure, "dashboard/hooks/useLocalhostForward");
          });
          showToast(`Copied ${localLabel} (forwarding remote port ${remotePort})`, "success");
        }
        return url;
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/hooks/useLocalhostForward");
        showToast("Could not open the tunnel to localhost.", "error");
        return null;
      }
    },
    [canForward, serverId, showToast],
  );

  return { canForward, forward };
}
