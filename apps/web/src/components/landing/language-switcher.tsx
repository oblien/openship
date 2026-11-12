"use client";

import { useLocale } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { APP_LOCALES, type AppLocale } from "@repo/core/locale";
import { isLocalizedPath, languageNames, localizedHref, withoutLocale } from "@/i18n/routing";
import { useCopy } from "@/i18n/use-copy";

export function LanguageSwitcher({ dark = false }: { dark?: boolean }) {
  const copy = useCopy();
  const locale = useLocale() as AppLocale;
  const pathname = withoutLocale(usePathname());
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div
      ref={container}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => {
          const links = Array.from(
            container.current?.querySelectorAll<HTMLAnchorElement>("a") ?? [],
          );
          const current = links.indexOf(document.activeElement as HTMLAnchorElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? links.length - 1
                : event.key === "ArrowDown"
                  ? (current + 1) % links.length
                  : current < 0
                    ? links.length - 1
                    : (current - 1 + links.length) % links.length;
          links[next]?.focus();
        });
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={copy("Language")}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 min-w-11 items-center justify-center gap-1 rounded-full px-2 text-xs font-medium transition-colors hover:bg-[var(--th-sf-04)] focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ color: dark ? "rgba(255,255,255,.75)" : "var(--th-text-secondary)" }}
      >
        <span lang={locale}>{languageNames[locale].short}</span>
        <svg
          className="size-3"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path d="m3 4.5 3 3 3-3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          id={id}
          className="absolute end-0 top-[calc(100%+10px)] z-50 w-44 rounded-2xl border border-[var(--th-bd-default)] bg-[var(--th-bg-page)] p-1.5 text-[var(--th-text-title)] shadow-xl"
        >
          {APP_LOCALES.map((target) => (
            <a
              key={target}
              href={localizedHref(isLocalizedPath(pathname) ? pathname : "/", target)}
              hrefLang={target}
              lang={target}
              dir={target === "ar" ? "rtl" : "ltr"}
              aria-current={locale === target ? "true" : undefined}
              className="flex items-center justify-between rounded-xl px-3 py-2 text-sm hover:bg-[var(--th-sf-04)] focus-visible:bg-[var(--th-sf-04)] focus-visible:outline-none"
              onClick={(event) => {
                const current = withoutLocale(window.location.pathname);
                event.currentTarget.href =
                  localizedHref(isLocalizedPath(current) ? current : "/", target) +
                  window.location.search +
                  window.location.hash;
                setOpen(false);
              }}
            >
              {languageNames[target].name}
              {locale === target && <span aria-hidden="true">✓</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
