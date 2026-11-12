"use client";

import NextLink from "next/link";
import { useLocale } from "next-intl";
import { forwardRef, type ComponentProps } from "react";
import type { AppLocale } from "@repo/core/locale";
import { localizedHref } from "./routing";

/** Marketing links retain the active language; docs and external links keep their URLs. */
export const Link = forwardRef<HTMLAnchorElement, ComponentProps<typeof NextLink>>(
  function LocalizedLink({ href, ...props }, ref) {
    const locale = useLocale() as AppLocale;
    const target =
      typeof href === "string"
        ? localizedHref(href, locale)
        : href.pathname
          ? { ...href, pathname: localizedHref(href.pathname, locale) }
          : href;
    return <NextLink ref={ref} href={target} {...props} />;
  },
);
