import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import * as rootParams from "next/root-params";
import { loadCatalog } from "./catalogs";
import { routing } from "./routing";

export default getRequestConfig(async ({ locale }) => {
  const matched = locale ?? (await rootParams.locale()) ?? routing.defaultLocale;
  // The website layout rejects unsupported locale segments. The global 404 also
  // uses marketing chrome, so its translations need a valid English fallback.
  const resolved = hasLocale(routing.locales, matched) ? matched : routing.defaultLocale;
  const catalog = await loadCatalog(resolved);
  return {
    locale: resolved,
    timeZone: "UTC",
    messages: { ...catalog, Copy: { ...catalog.Copy, ...catalog.ReleaseNotes } },
  };
});
