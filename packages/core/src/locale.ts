export const APP_LOCALES = ["en", "ar", "es", "fr", "de", "pt", "ja", "zh", "tr", "ru"] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
export function appLocale(value: unknown): AppLocale {
  return typeof value === "string" && (APP_LOCALES as readonly string[]).includes(value)
    ? (value as AppLocale)
    : "en";
}
