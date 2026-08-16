"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";

interface MobileSidebarContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const MobileSidebarContext = createContext<MobileSidebarContextValue>({
  open: false,
  setOpen: () => {},
});

export function useMobileSidebar() {
  return useContext(MobileSidebarContext);
}

/**
 * Shared open/close state for the mobile sidebar drawer, so the hamburger
 * trigger (mobile top bar) and the drawer itself (sidebar) can live as
 * separate components without prop-drilling through the server layout.
 */
export function MobileSidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Auto-close on navigation - otherwise the drawer stays open over the
  // newly-loaded page after tapping a nav link.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock page scroll behind the drawer while it's open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const value = useMemo(() => ({ open, setOpen }), [open]);

  return (
    <MobileSidebarContext.Provider value={value}>
      {children}
    </MobileSidebarContext.Provider>
  );
}
