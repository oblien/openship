import type { AppLocale } from "@repo/core/locale";

declare module "next-intl" {
  interface AppConfig {
    Locale: AppLocale;
  }
}
