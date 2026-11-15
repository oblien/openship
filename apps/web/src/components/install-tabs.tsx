"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { reportCaughtError } from "@repo/core/diagnostics";
import { usePlatform } from "@/hooks/use-platform";

// Shared by the documentation and download page. Commands are never translated.
const METHODS = [
  { key: "unix", label: "macOS / Linux", prompt: "$", cmd: "curl -fsSL https://get.openship.io | sh" },
  { key: "windows", label: "Windows", prompt: "PS>", cmd: "irm https://git.openship.io/windows | iex" },
  { key: "npm", label: "npm", prompt: "$", cmd: "npm i -g openship" },
  { key: "pnpm", label: "pnpm", prompt: "$", cmd: "pnpm add -g openship" },
  { key: "yarn", label: "yarn", prompt: "$", cmd: "yarn global add openship" },
  { key: "bun", label: "bun", prompt: "$", cmd: "bun add -g openship" },
] as const;

type Method = (typeof METHODS)[number]["key"];
const DEFAULT_LABELS = {
  methods: "Install method",
  copy: "Copy install command",
  copied: "Copied!",
  error: "Could not copy. Select the command to copy it.",
};

export function InstallTabs({
  includePackageManagers = false,
  labels = DEFAULT_LABELS,
}: {
  includePackageManagers?: boolean;
  labels?: typeof DEFAULT_LABELS;
}) {
  const { platform } = usePlatform();
  const [selection, setSelection] = useState<Method | null>(null);
  const [feedback, setFeedback] = useState<{ command: string; status: "copied" | "error" } | null>(null);
  const methods = includePackageManagers ? METHODS : METHODS.slice(0, 2);
  const active = selection ?? (platform === "windows" ? "windows" : "unix");
  const method = methods.find((item) => item.key === active) ?? methods[0];
  const status = feedback?.command === method.cmd ? feedback.status : null;

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 2500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(method.cmd);
      setFeedback({ command: method.cmd, status: "copied" });
    } catch (error) {
      reportCaughtError(error, "web/components/install-tabs");
      setFeedback({ command: method.cmd, status: "error" });
    }
  }

  return (
    <div className="install-tabs my-4 overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
      <div role="group" aria-label={labels.methods} className="install-methods flex flex-wrap gap-1 bg-neutral-50 p-2 dark:bg-neutral-900/60">
        {methods.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={method.key === item.key}
            onClick={() => { setSelection(item.key); setFeedback(null); }}
            className="rounded-lg px-3 py-2 text-[13px] text-neutral-500 transition-colors hover:text-neutral-900 aria-pressed:bg-white aria-pressed:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 dark:hover:text-neutral-100 dark:aria-pressed:bg-neutral-800 dark:aria-pressed:text-neutral-100"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="install-command flex min-w-0 items-center gap-3 bg-neutral-950 p-5" dir="ltr">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-neutral-100">
          <span aria-hidden="true" className="select-none text-neutral-500">{method.prompt} </span>
          <span data-install-command>{method.cmd}</span>
        </code>
        <button
          type="button"
          onClick={copyCommand}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-label={status === "copied" ? labels.copied : labels.copy}
          title={status === "copied" ? labels.copied : labels.copy}
        >
          {status === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        </button>
      </div>
      <p role="status" className={status === "error" ? "m-0 bg-neutral-50 px-5 py-3 text-sm text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300" : "sr-only"}>
        {status === "error" ? labels.error : status === "copied" ? labels.copied : ""}
      </p>
    </div>
  );
}
