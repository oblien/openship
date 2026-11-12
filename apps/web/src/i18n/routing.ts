import { APP_LOCALES, type AppLocale } from "@repo/core/locale";
import { defineRouting } from "next-intl/routing";
import paths from "./paths.json";

export const routing = defineRouting({
  locales: APP_LOCALES,
  defaultLocale: "en",
  localePrefix: "as-needed",
  localeDetection: false,
  alternateLinks: false,
  localeCookie: false,
});

export const languageNames: Record<AppLocale, { name: string; short: string }> = {
  en: { name: "English", short: "EN" },
  ar: { name: "العربية", short: "ع" },
  es: { name: "Español", short: "ES" },
  fr: { name: "Français", short: "FR" },
  de: { name: "Deutsch", short: "DE" },
  pt: { name: "Português", short: "PT" },
  ja: { name: "日本語", short: "日" },
  zh: { name: "简体中文", short: "中" },
  tr: { name: "Türkçe", short: "TR" },
  ru: { name: "Русский", short: "РУ" },
};

const sections = new Set(["", ...paths.localized]);

export function isLocalizedPath(pathname: string): boolean {
  const path = pathname.split(/[?#]/)[0];
  return path.startsWith("/") && !path.startsWith("//") && sections.has(path.split("/")[1] ?? "");
}

export function withoutLocale(pathname: string): string {
  const first = /^\/([^/?#]+)(?=\/|[?#]|$)/.exec(pathname)?.[1];
  if (!first || !APP_LOCALES.some((locale) => locale === first)) return pathname;
  const rest = pathname.slice(first.length + 1);
  return !rest || /^[?#]/.test(rest) ? `/${rest}` : rest;
}

export function localizedHref(href: string, locale: AppLocale): string {
  const pathname = withoutLocale(href);
  if (locale === "en" || !isLocalizedPath(pathname)) return pathname;
  const boundary = pathname.search(/[?#]/);
  const route = boundary < 0 ? pathname : pathname.slice(0, boundary);
  const suffix = boundary < 0 ? "" : pathname.slice(boundary);
  return `/${locale}${route === "/" ? "" : route}${suffix}`;
}

export function languageAlternates(pathname: string) {
  return Object.fromEntries([
    ...APP_LOCALES.map((locale) => [
      locale,
      `https://openship.io${localizedHref(pathname, locale)}`,
    ]),
    ["x-default", `https://openship.io${pathname}`],
  ]);
}
