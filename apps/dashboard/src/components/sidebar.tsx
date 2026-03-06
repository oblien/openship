"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
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
} from "lucide-react";
import { signOut } from "@/lib/auth-client";
import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/components/i18n-provider";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Logo } from "@/components/logo";
import type { User } from "@/lib/server/session";

const NAV_ITEMS = [
  { key: "projects",    href: "/projects",    icon: FolderKanban },
  { key: "deployments", href: "/deployments", icon: Rocket },
  { key: "domains",     href: "/domains",     icon: Globe },
  { key: "monitoring",  href: "/monitoring",  icon: Activity },
  { key: "settings",    href: "/settings",    icon: Settings },
  { key: "billing",     href: "/billing",     icon: CreditCard },
] as const;

export function Sidebar({ user }: { user: User }) {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, toggle } = useTheme();
  const { t } = useI18n();
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

  return (
    <aside className="flex h-dvh w-[260px] shrink-0 flex-col border-r border-border bg-card">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-5 pt-6 pb-8">
        <Logo size={24} />
        <span className="text-[17px] font-semibold tracking-tight text-foreground">
          {t.brand}
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-3">
        {NAV_ITEMS.map(({ key, href, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          const label = (t.dashboard.nav as Record<string, string>)[key] ?? key;

          return (
            <Link
              key={key}
              href={href}
              className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                active
                  ? "bg-foreground/[0.06] text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
              }`}
            >
              <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div className="border-t border-border px-3 py-3">
        {/* Controls row */}
        <div className="mb-2 flex items-center gap-1 px-1">
          <button
            onClick={toggle}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label={t.auth.toggleTheme}
          >
            {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <LanguageSwitcher />
        </div>

        {/* User + logout */}
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
          {/* Avatar */}
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-xs font-semibold uppercase text-foreground">
            {user.name?.[0] ?? user.email[0]}
          </div>

          {/* Name / email */}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium leading-tight text-foreground">
              {user.name || user.email.split("@")[0]}
            </p>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">
              {user.email}
            </p>
          </div>

          {/* Logout */}
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
            aria-label={t.dashboard.user.logout}
            title={t.dashboard.user.logout}
          >
            {loggingOut ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}
