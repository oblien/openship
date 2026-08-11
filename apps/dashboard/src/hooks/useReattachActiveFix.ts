"use client";

/**
 * useReattachActiveFix — on mount, re-open the prepare modal for an edge/mail
 * operation that is ALREADY running server-side, so a browser refresh (or first
 * navigation to a surface) during an install / image-swap resumes the live run
 * instead of losing it. It only ever READS the in-memory session state and
 * opens the modal in GET re-attach mode — it never POSTs, so it can never start
 * a run the user didn't ask for.
 *
 * Scope note: this is the container-updates + issues + mail-banner surface. The
 * server-setup WIZARD (`servers/[serverId]/page.tsx`) already re-attaches the
 * INSTALL session into its inline components tab, so container surfaces pass
 * only `containerTargets` (never `install`) to avoid a second UI for one run.
 */

import { useEffect, useRef } from "react";
import { systemApi } from "@/lib/api";
import { useServerEdgeInstallModal, useContainerApplyModal } from "./useSystemPrepareModal";

interface ContainerTarget {
  serverId: string;
  component: "edge" | "mail";
  /** Modal noun override (e.g. "mail engine"); cosmetic. */
  label?: string;
  /** Fired when a re-attached run completes, so a surface can refresh itself. */
  onDone?: () => void;
}

export function useReattachActiveFix(targets: {
  /** Check the shared install/repair session (edge). Omit on wizard surfaces. */
  install?: boolean;
  containerTargets?: ContainerTarget[];
}) {
  const openEdgeInstall = useServerEdgeInstallModal();
  const openContainerApply = useContainerApplyModal();
  // At most ONE modal, ever: once opened we never re-open (not on a dep change,
  // and not after the user closes it). StrictMode-safe alongside the `cancelled`
  // flag below — the discarded first pass can't sneak a modal open post-cleanup.
  const openedRef = useRef(false);

  // Key on the SERIALIZED targets, not `[]`: container rows load async, so an
  // `[]`-dep effect would run once before the rows exist and never re-check. The
  // opened-once ref still bounds this to a single modal.
  const key = JSON.stringify({
    install: !!targets.install,
    targets: (targets.containerTargets ?? []).map((t) => [t.serverId, t.component]),
  });

  useEffect(() => {
    if (openedRef.current) return;
    let cancelled = false;

    void (async () => {
      // Install first (its surface is the issues page). A running install/repair
      // hands back the session's OWN serverId, so re-attach targets that box.
      if (targets.install) {
        try {
          const s = await systemApi.getInstallSession();
          if (!cancelled && !openedRef.current && s.active && s.status === "running" && s.sessionId && s.serverId) {
            openedRef.current = true;
            openEdgeInstall(s.serverId, { attachSessionId: s.sessionId });
            return;
          }
        } catch {
          /* nothing running — a missing/finished session is the common case */
        }
      }

      for (const target of targets.containerTargets ?? []) {
        if (cancelled || openedRef.current) return;
        try {
          const s = await systemApi.getContainerApplySession(target.serverId, target.component);
          if (!cancelled && !openedRef.current && s.active && s.status === "running" && s.sessionId) {
            openedRef.current = true;
            openContainerApply(target.serverId, target.component, {
              label: target.label,
              attachSessionId: s.sessionId,
              onDone: target.onDone,
            });
            return;
          }
        } catch {
          /* nothing running for this (server, component) */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, openEdgeInstall, openContainerApply]);
}
