"use client";

import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/components/i18n-provider";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Moon, Sun, SunMoon } from "lucide-react";

/**
 * Shared wrapper for auth pages (login, register, forgot-password, etc.).
 * Provides centered layout, brand, and theme toggle.
 */
export function AuthShell({
  children,
  maxWidth = "max-w-[400px]",
  align = "center",
  onBack,
}: {
  children: React.ReactNode;
  maxWidth?: string;
  /**
   * Vertical placement. `center` is right for a short form. Pass `start` for
   * anything tall: centering a page taller than the viewport pushes its top ABOVE
   * the scroll origin (unreachable), and it breaks `lg:sticky` children, which
   * need a normal-flow top edge to stick against.
   */
  align?: "center" | "start";
  /** When provided, renders a back button in the top bar */
  onBack?: () => void;
}) {
  const { resolvedTheme, toggle } = useTheme();
  const { t } = useI18n();

  return (
    <div
      className={`flex min-h-dvh flex-col items-center px-4 ${
        align === "start" ? "justify-start pb-12 pt-20" : "justify-center py-12"
      }`}
    >
      {/* Top bar - logo left, controls right */}
      <div
        data-app-topinset
        className="fixed inset-x-0 top-0 flex items-center justify-between px-5 py-4"
      >
        <div className="flex items-center gap-2.5">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              aria-label={t.auth.back ?? "Back"}
              className="me-1"
            >
              <ArrowLeft className="size-4 rtl:rotate-180" />
            </Button>
          )}
          <Logo size={24} />
          <span className="text-[16px] font-semibold tracking-tight text-foreground">
            {t.brand}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={t.auth.toggleTheme}
          >
            {resolvedTheme === "light" ? <Sun /> : resolvedTheme === "dim" ? <SunMoon /> : <Moon />}
          </Button>
        </div>
      </div>

      <div className={`w-full ${maxWidth}`}>
        {children}
      </div>
    </div>
  );
}
