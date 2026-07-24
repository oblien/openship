"use client";

/**
 * Settings → General → Language. Switches the interface locale via the shared
 * I18nProvider (which flips <html lang/dir>, so RTL for Arabic is automatic).
 * Each language is a selectable card showing its AUTONYM — its own name, in its
 * own script (中文, Español, …), never translated into the current UI language.
 */

import { Languages, Check } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { isRtl, locales, type Locale } from "@/i18n";
import { SettingsSection } from "./SettingsSection";

/** Each language's own name, in its own script (never translated). */
const NATIVE: Record<Locale, string> = {
  en: "English",
  ar: "العربية",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  ja: "日本語",
  zh: "中文",
  tr: "Türkçe",
};

/** Short glyph for the card's leading tile. */
const CODE: Record<Locale, string> = {
  en: "EN",
  ar: "ع",
  es: "ES",
  fr: "FR",
  de: "DE",
  pt: "PT",
  ja: "日",
  zh: "中",
  tr: "TR",
};

export function LanguageSetting() {
  const { locale, setLocale, t } = useI18n();

  return (
    <SettingsSection
      icon={Languages}
      title={t.settings.language.title}
      description={t.settings.language.description}
      collapsible
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {locales.map((l) => {
          const active = l === locale;
          return (
            <button
              key={l}
              type="button"
              onClick={() => setLocale(l)}
              aria-pressed={active}
              lang={l}
              dir={isRtl(l) ? "rtl" : "ltr"}
              className={`group relative flex items-center gap-3 rounded-xl border p-4 text-start transition-all ${
                active
                  ? "border-primary/50 bg-primary/[0.06] ring-1 ring-primary/25"
                  : "border-border/50 bg-muted/10 hover:border-border hover:bg-muted/30"
              }`}
            >
              <div
                className={`flex size-11 shrink-0 items-center justify-center rounded-lg text-[15px] font-semibold transition-colors ${
                  active
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground group-hover:text-foreground"
                }`}
              >
                {CODE[l]}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{NATIVE[l]}</p>
              </div>
              {active && (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="size-3.5" strokeWidth={2.5} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </SettingsSection>
  );
}
