import type { Metadata } from "next";
import type { AppLocale } from "@repo/core/locale";
import { getLocale, getTranslations } from "next-intl/server";
import { createCopy, translateCopyData } from "./copy";
import { isLocalizedPath, languageAlternates, localizedHref, withoutLocale } from "./routing";

export async function localizedMetadata(metadata: Metadata): Promise<Metadata> {
  const locale = (await getLocale()) as AppLocale;
  const copy = createCopy(await getTranslations({ locale, namespace: "Copy" }));
  const result = translateCopyData(metadata, copy);
  const title = (value: string) => {
    const translated = copy(value);
    return translated !== value
      ? translated
      : value
          .split(/( [—–-] )/)
          .map((part) => copy(part))
          .join("");
  };
  if (typeof metadata.title === "string") result.title = title(metadata.title);
  else if (metadata.title && typeof metadata.title === "object" && "absolute" in metadata.title) {
    result.title = { absolute: title(metadata.title.absolute) };
  }
  if (result.openGraph && typeof metadata.openGraph?.title === "string")
    result.openGraph.title = title(metadata.openGraph.title);
  if (result.twitter && typeof metadata.twitter?.title === "string")
    result.twitter.title = title(metadata.twitter.title);
  const canonical = metadata.alternates?.canonical;
  const pathname =
    typeof canonical === "string"
      ? withoutLocale(canonical.replace(/^https:\/\/openship\.io(?=\/|$)/, "") || "/")
      : undefined;
  if (pathname && isLocalizedPath(pathname)) {
    result.alternates = {
      ...result.alternates,
      canonical: localizedHref(pathname, locale),
      languages: languageAlternates(pathname),
    };
    if (result.openGraph)
      result.openGraph = { ...result.openGraph, locale, url: localizedHref(pathname, locale) };
  }
  return result;
}
