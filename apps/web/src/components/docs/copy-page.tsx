"use client";

import { useEffect, useState } from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { reportCaughtError } from "@repo/core/diagnostics";

/** Fetch only on request; the adjacent Markdown link also works without clipboard access. */
export function CopyPage({ markdownUrl }: { markdownUrl: string }) {
  const [status, setStatus] = useState<"idle" | "loading" | "copied" | "error">("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function copy() {
    setStatus("loading");
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
      const content = fetch(markdownUrl).then(async (response) => {
        if (!response.ok) throw new Error(`Could not load documentation (${response.status})`);
        return response.text();
      });
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        // Start the write in the click gesture, including Safari, while the content loads.
        const blob = content.then((text) => new Blob([text], { type: "text/plain" }));
        await Promise.all([
          blob,
          navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]),
        ]);
      } else {
        await navigator.clipboard.writeText(await content);
      }
      setStatus("copied");
    } catch (error) {
      reportCaughtError(error, "web/docs/copy-page");
      setStatus("error");
    }
  }

  const Icon = status === "copied" ? Check : status === "loading" ? LoaderCircle : Copy;
  return (
    <span className="docs-copy-page">
      <button type="button" onClick={copy} disabled={status === "loading"}>
        <Icon size={14} aria-hidden="true" />
        {status === "copied" ? "Copied" : status === "loading" ? "Copying…" : "Copy Markdown"}
      </button>
      <span role="status" className={status === "error" ? "docs-copy-error" : "sr-only"}>
        {status === "error"
          ? "Could not copy. Use View Markdown to copy the text."
          : status === "copied"
            ? "Markdown copied to clipboard."
            : ""}
      </span>
    </span>
  );
}
