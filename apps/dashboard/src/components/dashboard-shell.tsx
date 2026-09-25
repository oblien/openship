"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Logo } from "./logo";
import { useBrandName, useI18n } from "./i18n-provider";

/** Keep the page usable on phones; navigation opens above it, without taking its width. */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const brand = useBrandName();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);

  useEffect(() => { setMobileOpen(false); }, [pathname]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const changed = () => { if (media.matches) setMobileOpen(false); };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    drawer.current?.querySelector<HTMLButtonElement>('button[aria-controls="dashboard-sidebar"]')?.focus();
    return () => { trigger.current?.focus(); };
  }, [mobileOpen]);

  return <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
    <header inert={mobileOpen} className="flex h-14 shrink-0 items-center justify-between border-b border-border/40 px-4 md:hidden">
      <span className="flex items-center gap-2.5 text-sm font-semibold text-foreground"><Logo size={24} />{brand}</span>
      <button ref={trigger} type="button" onClick={() => setMobileOpen(true)} aria-label={t.dashboard.sidebar.expand}
        aria-controls="dashboard-navigation" aria-expanded={mobileOpen} className="flex size-10 items-center justify-center rounded-xl text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">
        <UiIcon name="menu" className="size-5" aria-hidden="true" />
      </button>
    </header>
    {mobileOpen && <div aria-hidden="true" className="fixed inset-0 z-40 touch-none bg-black/40 md:hidden" onClick={() => setMobileOpen(false)} />}
    <div ref={drawer} id="dashboard-navigation" role={mobileOpen ? "dialog" : undefined} aria-modal={mobileOpen ? true : undefined}
      aria-label={mobileOpen ? t.dashboard.nav.sections.main : undefined}
      className={`fixed inset-y-0 start-0 z-50 bg-background shadow-xl ${mobileOpen ? "flex" : "hidden"} md:static md:z-auto md:flex md:bg-transparent md:shadow-none`}
      onClick={event => { if (mobileOpen && (event.target as HTMLElement).closest("a[href]")) setMobileOpen(false); }}
      onKeyDown={event => {
        if (!mobileOpen) return;
        if (event.key === "Escape") { event.preventDefault(); setMobileOpen(false); return; }
        if (event.key !== "Tab") return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select, [tabindex="0"]')]
          .filter(element => element.getClientRects().length > 0);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <Sidebar mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />
    </div>
    <main inert={mobileOpen} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain">{children}</main>
  </div>;
}
