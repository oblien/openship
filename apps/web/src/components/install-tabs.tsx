"use client";

import { useEffect, useState } from "react";
import { usePlatform } from "@/hooks/use-platform";

type TabKey = "unix" | "windows";

/**
 * One-line installers for the self-hosted server. macOS/Linux go through the
 * pretty domain (Cloudflare → raw install.sh); Windows hits the raw script
 * directly so it works with no extra redirect rule.
 */
const TABS: { key: TabKey; label: string; prompt: string; cmd: string }[] = [
  {
    key: "unix",
    label: "macOS / Linux",
    prompt: "$",
    cmd: "curl -fsSL https://get.openship.io | sh",
  },
  {
    key: "windows",
    label: "Windows",
    prompt: "PS>",
    cmd: "irm https://git.openship.io/windows | iex",
  },
];

export function InstallTabs() {
  const { platform } = usePlatform();
  const [active, setActive] = useState<TabKey>("unix");
  const [copied, setCopied] = useState(false);

  // Auto-select the visitor's OS once detected (everything non-Windows → unix).
  useEffect(() => {
    if (platform === "windows") setActive("windows");
  }, [platform]);

  const tab = TABS.find((t) => t.key === active)!;

  function copy() {
    void navigator.clipboard.writeText(tab.cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div className="flex border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/60">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={
              "px-4 py-2 text-[13px] font-medium transition-colors " +
              (active === t.key
                ? "border-b-2 border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
                : "border-b-2 border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-300")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 bg-neutral-950 px-4 py-3">
        <code className="overflow-x-auto whitespace-nowrap font-mono text-[13px] text-neutral-100">
          <span className="select-none text-neutral-500">{tab.prompt} </span>
          {tab.cmd}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded px-2 py-1 text-[12px] text-neutral-400 transition-colors hover:text-neutral-100"
          aria-label="Copy install command"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
    </div>
  );
}
