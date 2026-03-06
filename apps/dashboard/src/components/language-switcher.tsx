"use client";

import { useI18n } from "@/components/i18n-provider";
import { locales, type Locale } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Globe } from "lucide-react";

const labels: Record<Locale, string> = {
  en: "EN",
  ar: "عر",
};

/**
 * Cycles through available locales on click.
 * Compact icon button — shows the current locale code.
 */
export function LanguageSwitcher() {
  const { locale, setLocale } = useI18n();

  function next() {
    const idx = locales.indexOf(locale);
    setLocale(locales[(idx + 1) % locales.length]);
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={next}
      aria-label="Switch language"
      className="text-xs font-semibold"
    >
      <Globe className="size-4" />
    </Button>
  );
}
