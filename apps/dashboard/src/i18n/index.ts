import en from "./dictionaries/en.json";
import ar from "./dictionaries/ar.json";

export type Dictionary = typeof en;
export const dictionaries: Record<string, Dictionary> = { en, ar };

export type Locale = keyof typeof dictionaries & string;

export const defaultLocale: Locale = "en";
export const locales: Locale[] = Object.keys(dictionaries);

/** RTL languages */
const rtlLocales = new Set<Locale>(["ar"]);
export function isRtl(locale: Locale) {
  return rtlLocales.has(locale);
}
