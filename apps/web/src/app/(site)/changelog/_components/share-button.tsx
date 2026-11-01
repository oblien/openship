"use client";
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
  const [copied, setCopied] = useState(false);

  async function copy(e: React.MouseEvent) {
    e.preventDefault();
    const url = `${window.location.origin}/changelog/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      reportCaughtError(error, "web/app/(site)/changelog/_components/share-button");
      window.location.href = `/changelog/${slug}`;
    }
  }

  return (
    <a
      href={`/changelog/${slug}`}
      onClick={copy}
      aria-label="Copy link to this update"
      className={`changelog-share ${className}`}
    >
      {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
      {copied ? "Copied" : "Copy link"}
    </a>
  );
}
