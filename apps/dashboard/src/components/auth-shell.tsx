"use client";

import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/components/i18n-provider";
import { Logo } from "@/components/logo";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";

/**
 * Shared wrapper for auth pages (login, register, forgot-password, etc.).
 * Provides centered layout, brand, theme toggle, and language switcher.
 */
export function AuthShell({
  children,
  maxWidth = "max-w-[400px]",
}: {
  children: React.ReactNode;
  maxWidth?: string;
}) {
  const { resolvedTheme, toggle } = useTheme();
  const { t } = useI18n();

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      {/* Top-right controls */}
      <div className="fixed right-5 top-5 flex items-center gap-1">
        <LanguageSwitcher />
        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          aria-label={t.auth.toggleTheme}
        >
          {resolvedTheme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </div>

      <div className={`w-full ${maxWidth}`}>
        {/* Brand */}
        <div className="mb-10 flex items-center justify-center gap-2.5">
          <Logo size={28} />
          <span className="text-[22px] font-semibold tracking-tight text-foreground">
            {t.brand}
          </span>
        </div>

        {children}
      </div>
    </div>
  );
}
