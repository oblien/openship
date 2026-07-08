"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

interface CodeBlockProps {
  language: string;
  filename: string;
  children: string;
}

export function CodeBlock({ language, filename, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable on http */
    }
  };
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-black/40">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.03] px-4 py-2">
        <span className="font-mono text-[11px] text-white/60">{filename}</span>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-white/60 transition-colors hover:text-white"
          aria-label={`Copy ${language} snippet`}
        >
          {copied ? (
            <>
              <Check className="size-3 text-emerald-400" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-white">
        <code>{children}</code>
      </pre>
    </div>
  );
}
