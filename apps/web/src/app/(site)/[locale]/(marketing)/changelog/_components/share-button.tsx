"use client";
import { useLocale } from "next-intl";
import { localizedHref } from "@/i18n/routing";
import { useCopy } from "@/i18n/use-copy";

import { reportCaughtError } from "@repo/core/diagnostics";

import { useState } from "react";
import { Link2, Check } from "lucide-react";

/**
 * Copy a shareable link to a single changelog entry. Clicking copies
 * `<origin>/changelog/<slug>` to the clipboard (opening that link pins the
 * entry to the top of the page and highlights it). The element is a real
 * anchor too, so right-click / open-in-new-tab and no-JS both still work.
 */
export function ShareButton({ slug, className = "" }: { slug: string; className?: string }) {
  const copy = useCopy();
  const locale = useLocale();
  const href = localizedHref(`/changelog/${slug}`, locale);

  const [copied, setCopied] = useState(false);

  async function copyLink(e: React.MouseEvent) {
    e.preventDefault();
    const url = `${window.location.origin}${href}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      reportCaughtError(error, "web/app/(site)/changelog/_components/share-button");
      window.location.href = href;
    }
  }

  return (
    <a
      href={href}
      onClick={copyLink}
      aria-label={copy("Copy link to this update")}
      className={`changelog-share ${className}`}
    >
      {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
      {copied ? copy("Copied") : copy("Copy link")}
    </a>
  );
}
