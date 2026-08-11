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
  baseDictionary,
  defaultLocale,
  isRtl,
  loadDictionary,
  LOCALE_COOKIE,
  locales,
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

/** Read the chosen locale on the client: cookie first (what SSR also reads),
 *  then the localStorage mirror. Returns null when nothing valid is stored. */
function readClientLocale(): Locale | null {
  if (typeof document !== "undefined") {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
    const fromCookie = m ? decodeURIComponent(m[1]) : null;
    if (fromCookie && (locales as readonly string[]).includes(fromCookie)) return fromCookie as Locale;
  }
  try {
    const fromLs = localStorage.getItem(LOCALE_COOKIE);
    if (fromLs && (locales as readonly string[]).includes(fromLs)) return fromLs as Locale;
  } catch {
    /* storage disabled */
  }
  return null;
}

export function I18nProvider({
  children,
  initialLocale = defaultLocale,
  initialDictionary,
}: {
  children: React.ReactNode;
  /** Locale resolved on the server from the cookie, so first paint matches. */
  initialLocale?: Locale;
  /** Active locale's dictionary, loaded server-side for non-English so SSR
   *  renders in the right language with no English→translated flash. */
  initialDictionary?: Dictionary;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  // Seeded with the server-resolved dictionary (or bundled English), so the
  // client hydrates in the same language the server rendered — no flash when
  // SSR read the cookie.
  const [t, setT] = useState<Dictionary>(initialDictionary ?? baseDictionary);

  // Safety net: if the server render fell back to the default (couldn't surface
  // the request cookie to SSR), reconcile from the cookie/localStorage on mount
  // so the chosen locale ALWAYS survives a reload. No-op when SSR already got it
  // right (stored === current) — so the common path stays flash-free.
  useEffect(() => {
    const stored = readClientLocale();
    if (stored && stored !== initialLocale) setLocaleState(stored);
    // Mount-only: initialLocale is the server value for this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload the dictionary when the locale changes at runtime (base resolves
  // instantly; the initial locale is already seeded above so mount is a no-op).
  useEffect(() => {
    let alive = true;
    void loadDictionary(locale).then((d) => {
      if (alive) setT(d);
    });
    return () => {
      alive = false;
    };
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    // Cookie is the source of truth (read server-side for SSR); localStorage is
    // kept as a mirror. 1-year, lax so it rides top-level navigations.
    document.cookie = `${LOCALE_COOKIE}=${l};path=/;max-age=31536000;samesite=lax`;
    try {
      localStorage.setItem(LOCALE_COOKIE, l);
    } catch {
      /* private mode / disabled storage — cookie still carries it */
    }
  }, []);

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
