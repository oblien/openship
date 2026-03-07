"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  FolderKanban,
  Rocket,
  Globe,
  Activity,
  Settings,
  CreditCard,
  LogOut,
  Loader2,
  Moon,
  Sun,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { signOut } from "@/lib/auth-client";
import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/components/i18n-provider";
import { Logo } from "@/components/logo";
import { useAuth } from "@/context/AuthContext";

const MAIN_NAV = [
  { key: "home",        href: "/",            icon: LayoutDashboard },
  { key: "projects",    href: "/projects",    icon: FolderKanban },
  { key: "deployments", href: "/deployments", icon: Rocket },
  { key: "domains",     href: "/domains",     icon: Globe },
  { key: "monitoring",  href: "/monitoring",  icon: Activity },
] as const;

const SETTINGS_NAV = [
  { key: "settings", href: "/settings", icon: Settings },
  { key: "billing",  href: "/billing",  icon: CreditCard },
] as const;

export function Sidebar() {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, toggle } = useTheme();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await signOut();
      router.push("/login");
    } catch {
      setLoggingOut(false);
    }
  }

  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(href + "/");

  const label = (key: string) =>
    (t.dashboard.nav as unknown as Record<string, string>)[key] ?? key;

  return (
    <aside
      className={`my-3 ml-3 flex shrink-0 flex-col rounded-2xl border border-border/50 bg-card transition-[width] duration-200 overflow-hidden ${
        collapsed ? "w-[72px]" : "w-[260px]"
      }`}
    >
      {/* ── Header ───────────────────────────────────────────── */}
      <div className={`flex items-center px-5 py-6 ${collapsed ? "flex-col gap-3 pb-3" : "justify-between"}`}>
        <div className="flex items-center gap-2.5 min-w-0">
          <Logo size={26} className="shrink-0" />
          {!collapsed && (
            <span className="text-base font-semibold tracking-tight text-foreground truncate">
              {t.brand}
            </span>
          )}
        </div>
        
        {/* Controls */}
        <div className={`flex items-center ${collapsed ? "flex-col gap-1" : "gap-1"}`}>
          <button
            onClick={toggle}
            className="flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label={t.auth.toggleTheme}
          >
            {resolvedTheme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </button>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label={collapsed ? t.dashboard.sidebar.expand : t.dashboard.sidebar.collapse}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
        </div>
      </div>

      <div className="mx-3 h-px bg-border/60" />

      {/* ── Main nav ─────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-3 pt-3 pb-1">
        {!collapsed && (
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            {t.dashboard.nav.sections.main}
          </p>
        )}
        <div className="space-y-1">
          {MAIN_NAV.map(({ key, href, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={key}
                href={href}
                title={collapsed ? label(key) : undefined}
                className={`flex items-center rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors ${
                  collapsed ? "justify-center" : "gap-3"
                } ${
                  active
                    ? "bg-foreground/[0.07] text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                }`}
              >
                <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
                {!collapsed && label(key)}
              </Link>
            );
          })}
        </div>

        {/* Settings group */}
        <div className="mt-5">
          {!collapsed && (
            <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              {t.dashboard.nav.sections.settings}
            </p>
          )}
          {collapsed && <div className="my-3 mx-2 h-px bg-border/60" />}
          <div className="space-y-1">
            {SETTINGS_NAV.map(({ key, href, icon: Icon }) => {
              const active = isActive(href);
              return (
                <Link
                  key={key}
                  href={href}
                  title={collapsed ? label(key) : undefined}
                  className={`flex items-center rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors ${
                    collapsed ? "justify-center" : "gap-3"
                  } ${
                    active
                      ? "bg-foreground/[0.07] text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                  }`}
                >
                  <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
                  {!collapsed && label(key)}
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* ── Account ──────────────────────────────────────────── */}
      <div className="px-3 pb-4 pt-1">
        <div className="mx-2 mb-3 h-px bg-border/60" />
        {!collapsed && (
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            {t.dashboard.nav.sections.account}
          </p>
        )}
        <div
          className={`flex items-center rounded-xl px-2 py-2 ${
            collapsed ? "justify-center" : "gap-3"
          }`}
        >
          {/* Avatar */}
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-sm font-semibold uppercase text-foreground">
            {user?.name?.[0] ?? user?.email?.[0] ?? "?"}
          </div>

          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium leading-tight text-foreground">
                  {user?.name || user?.email?.split("@")[0] || ""}
                </p>
                <p className="truncate text-[12px] leading-tight text-muted-foreground">
                  {user?.email}
                </p>
              </div>
              <button
                onClick={handleLogout}
                disabled={loggingOut}
                className="flex size-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
                aria-label={t.dashboard.user.logout}
                title={t.dashboard.user.logout}
              >
                {loggingOut ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <LogOut className="size-4" />
                )}
              </button>
            </>
          )}
        </div>

        {/* Collapsed: logout button below avatar */}
        {collapsed && (
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="mt-2 flex w-full items-center justify-center rounded-xl py-2.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
            title={t.dashboard.user.logout}
          >
            {loggingOut ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
          </button>
        )}
      </div>
    </aside>
  );
}

