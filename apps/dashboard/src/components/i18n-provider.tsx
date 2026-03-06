"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  dictionaries,
  defaultLocale,
  isRtl,
  type Dictionary,
  type Locale,
} from "@/i18n";

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

type I18nContextValue = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Dictionary;
  dir: "ltr" | "rtl";
};

const I18nContext = createContext<I18nContextValue | null>(null);

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "openship-locale";

function getInitialLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in dictionaries) return stored as Locale;
  // Try browser language
  const nav = navigator.language.split("-")[0];
  if (nav && nav in dictionaries) return nav as Locale;
  return defaultLocale;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  // Hydrate from localStorage after mount
  useEffect(() => {
    setLocaleState(getInitialLocale());
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem(STORAGE_KEY, l);
  }, []);

  const t = dictionaries[locale];
  const dir: "ltr" | "rtl" = isRtl(locale) ? "rtl" : "ltr";

  // Sync <html> attributes
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t, dir }),
    [locale, setLocale, t, dir],
  );

  return (
    <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}

/**
 * Simple string interpolation: replaces {key} tokens.
 *
 * @example interpolate("Sent to {email}.", { email: "a@b.c" })
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}
