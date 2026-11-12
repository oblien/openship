import type { AppLocale } from "@repo/core/locale";

export async function loadCatalog(locale: AppLocale) {
  return (await import(`./messages/${locale}.json`)).default;
}
