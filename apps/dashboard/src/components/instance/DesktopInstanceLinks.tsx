"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { isInvitationClaimPath, type DesktopInstanceLinkRequest } from "@repo/core";
import { InstanceConnectDialog } from "./InstanceConnectDialog";

/** The main process supplies only a validated address. Opening a link never
 * connects or accepts an invitation until the person uses the existing UI. */
export function DesktopInstanceLinks() {
  const pathname = usePathname();
  const [request, setRequest] = useState<DesktopInstanceLinkRequest | null>(null);
  const active = useRef<DesktopInstanceLinkRequest | null>(null);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    const bridge = window.desktop?.isDesktop && window.desktop.instanceLinks;
    if (!bridge) return;
    // Keep later links queued through the current invitation and its sign-in.
    // Otherwise a reload after connecting could stack a second confirmation
    // over the first invitation before the person has accepted or declined it.
    const path = pathname ?? window.location.pathname;
    if (
      isInvitationClaimPath(path) ||
      (["/login", "/register", "/two-factor"].includes(path) &&
        isInvitationClaimPath(new URLSearchParams(window.location.search).get("returnTo") ?? ""))
    )
      return;
    let mounted = true;
    const read = async () => {
      if (active.current) return;
      try {
        const pending = await bridge.pending();
        if (!mounted || active.current || !pending) return;
        active.current = pending;
        setRequest(pending);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/components/instance/DesktopInstanceLinks");
        // Manual connection remains available if the native bridge is closing.
      }
    };
    refresh.current = () => void read();
    const unsubscribe = bridge.onLink(refresh.current);
    void read(); // Includes a cold launch and a reload of an unconfirmed link.
    return () => {
      mounted = false;
      refresh.current = () => {};
      unsubscribe();
    };
  }, [pathname]);

  const acknowledge = useCallback(async () => {
    if (active.current) await window.desktop?.instanceLinks?.acknowledge(active.current.id);
  }, []);

  const dismiss = useCallback(() => {
    void acknowledge()
      .then(() => {
        active.current = null;
        setRequest(null);
        refresh.current();
      })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/instance/DesktopInstanceLinks");
        /* Keep the confirmation available if the native bridge is closing. */
      });
  }, [acknowledge]);

  return request ? (
    <InstanceConnectDialog
      key={request.id}
      initialAddress={request.address}
      onClose={dismiss}
      onConnected={acknowledge}
    />
  ) : null;
}
