"use client";

import { Menu, Moon, Sun, SunMoon } from "lucide-react";
import { Logo } from "@/components/logo";
import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/components/i18n-provider";
import { useMobileSidebar } from "@/context/MobileSidebarContext";

/**
 * Slim top bar shown below the `lg` breakpoint only. Desktop keeps the
 * always-visible sidebar; mobile gets this bar + the sidebar as an overlay
 * drawer (see sidebar.tsx) triggered by the hamburger here.
 */
export function MobileTopBar() {
  const { open, setOpen } = useMobileSidebar();
  const { resolvedTheme, toggle } = useTheme();
  const { t } = useI18n();

  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-card px-4 py-3 lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={open ? t.dashboard.sidebar.closeMenu : t.dashboard.sidebar.openMenu}
        aria-expanded={open}
        className="flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <Menu className="size-5" />
      </button>

      <div className="flex items-center gap-2">
        <Logo size={22} />
        <span className="text-[15px] font-semibold tracking-tight text-foreground">
          {t.brand}
        </span>
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-label={t.auth.toggleTheme}
        title={t.auth.toggleTheme}
        className="flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        {resolvedTheme === "light" ? (
          <Sun className="size-4" />
        ) : resolvedTheme === "dim" ? (
          <SunMoon className="size-4" />
        ) : (
          <Moon className="size-4" />
        )}
      </button>
    </div>
  );
}
