"use client";

import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/components/i18n-provider";
import { Logo } from "@/components/logo";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Moon, Sun } from "lucide-react";

/**
 * Shared wrapper for auth pages (login, register, forgot-password, etc.).
 * Provides centered layout, brand, theme toggle, and language switcher.
 */
export function AuthShell({
  children,
  maxWidth = "max-w-[400px]",
  onBack,
}: {
  children: React.ReactNode;
  maxWidth?: string;
  /** When provided, renders a back button in the top bar */
  onBack?: () => void;
}) {
  const { resolvedTheme, toggle } = useTheme();
  const { t } = useI18n();

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      {/* Top bar — logo left, controls right */}
      <div className="fixed inset-x-0 top-0 flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2.5">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              aria-label={t.auth.back ?? "Back"}
              className="mr-1"
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <Logo size={24} />
          <span className="text-[16px] font-semibold tracking-tight text-foreground">
            {t.brand}
          </span>
        </div>
        <div className="flex items-center gap-1">
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
      </div>

      <div className={`w-full ${maxWidth}`}>
        {children}
      </div>
    </div>
  );
}
