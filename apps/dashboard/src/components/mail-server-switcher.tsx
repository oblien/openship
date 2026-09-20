"use client";

/**
 * Which mail server the rail is scoped to — a compact row above the MAIL
 * section. In platform view /emails' own list view does this job; with the tabs
 * promoted to the rail there is no list to go back to, so the switch lives here.
 *
 * Switching preserves where you are — the `?tab=` you were reading, or the webmail
 * route: the operator picked a server WHILE reading Mailboxes, and landing back on
 * Overview each time makes comparing two servers needlessly tedious. `?domain=` is
 * intentionally not carried over — a domain belongs to one mail server (same
 * reasoning as `setServerInUrl` in emails/_components/mail-console.tsx).
 *
 * Renders nothing with fewer than two servers: a switcher with one option is
 * chrome that only takes up rail space.
 */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Check, ChevronsUpDown, Server } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { DismissiblePopover } from "@/components/ui/Popover";
import { useMailScope } from "@/context/MailScopeContext";
import { webmailHref } from "@/lib/sidebar-nav";

export function MailServerSwitcher({ collapsed }: { collapsed: boolean }) {
  const { t } = useI18n();
  const { servers, activeServerId, activeServer } = useMailScope();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  if (servers.length < 2) return null;

  // Both paths that render the console: mail view serves it at `/` as well
  // (`(dashboard)/page.tsx`). A `?tab=` read anywhere else is some other page's
  // query and must not follow the operator to a different mail server.
  const onConsole = pathname === "/emails" || pathname === "/";
  const currentTab = onConsole ? searchParams.get("tab") : null;

  // Always the canonical route, even when switching from `/` — the home alias is
  // a landing place, not a destination to keep the operator pinned to.
  const hrefFor = (serverId: string) => {
    // Webmail is a route rather than a `?tab=`, so it needs the same courtesy the
    // tabs get: switching servers there means "show me THIS server's webmail",
    // not "back to Overview".
    if (pathname === "/emails/webmail") return webmailHref(serverId);
    const params = new URLSearchParams();
    params.set("serverId", serverId);
    if (currentTab) params.set("tab", currentTab);
    return `/emails?${params.toString()}`;
  };

  const labelFor = (s: { domain: string | null; name: string }) => s.domain || s.name;
  const activeLabel = activeServer
    ? labelFor(activeServer)
    : t.chrome.mailRail.selectServer;

  return (
    <DismissiblePopover open={open} onOpenChange={setOpen} className="relative mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={collapsed ? activeLabel : undefined}
        className={`group flex w-full items-center rounded-xl px-2 py-2 text-start transition-colors hover:bg-foreground/[0.06] ${
          collapsed ? "justify-center" : "gap-2.5"
        }`}
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.08] text-foreground">
          <Server className="size-3.5" strokeWidth={1.8} />
        </div>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {activeLabel}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
          </>
        )}
      </button>

      {open && (
        <div
          className={`absolute z-50 overflow-hidden rounded-2xl border border-border/50 bg-popover shadow-xl shadow-black/[0.08] ${
            collapsed ? "start-full top-0 ms-2 w-64" : "start-0 end-0 top-full mt-1"
          }`}
        >
          <div className="px-3 pt-3 pb-2">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              {t.chrome.mailRail.switchServer}
            </p>
          </div>
          <div className="max-h-64 overflow-y-auto pb-1">
            {servers.map((s) => {
              const isCurrent = s.id === activeServerId;
              return (
                <Link
                  key={s.id}
                  href={hrefFor(s.id)}
                  onClick={() => setOpen(false)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 transition-colors hover:bg-foreground/[0.05] ${
                    isCurrent ? "bg-foreground/[0.03]" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium leading-tight text-foreground">
                      {labelFor(s)}
                    </p>
                    <p className="truncate text-[11px] leading-tight text-muted-foreground">
                      {s.completed ? s.host : t.chrome.mailRail.setupIncomplete}
                    </p>
                  </div>
                  {isCurrent && <Check className="size-4 shrink-0 text-primary" />}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </DismissiblePopover>
  );
}
