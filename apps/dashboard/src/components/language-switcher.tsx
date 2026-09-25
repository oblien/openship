"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useI18n } from "@/components/i18n-provider";
import { locales } from "@/i18n";
import { Button } from "@/components/ui/button";

/**
 * Cycles through available locales on click.
 * Compact icon button - shows the current locale code.
 */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  function next() {
    const idx = locales.indexOf(locale);
    setLocale(locales[(idx + 1) % locales.length]);
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={next}
      aria-label={t.settings.language.title}
      className="text-xs font-semibold"
    >
      <UiIcon name="globe" className="size-4" />
    </Button>
  );
}
