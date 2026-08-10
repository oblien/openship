"use client";

import { useState } from "react";
import { Check, Terminal } from "lucide-react";

import { useI18n } from "@/components/i18n-provider";

/**
 * How a self-hosted box upgrades its own control plane: the CLI reinstalls the
 * global package (CLI + bundled API + compose template), then — on a compose
 * install — repins `OPENSHIP_VERSION` and pulls the new api/dashboard/edge
 * images; on a bare install it restarts the service. One string, so every
 * surface that can't offer a working button points at the same command.
 */
export const SELF_UPDATE_COMMAND = "openship update";

/**
 * A command the operator has to run themselves, as a click-to-copy chip.
 *
 * Some updates genuinely can't be driven from the browser: a self-hosted box
 * upgrades its own control plane through the CLI, and the API refuses a redeploy
 * of it outright (`build.service.ts`). The honest UI there is the exact command,
 * not a button that cannot work — so every surface that would otherwise offer a
 * dead "Update" action renders this instead.
 */
export default function CopyCommand({
  command,
  className = "",
}: {
  command: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Non-HTTPS origin (a plain-IP self-hosted box) has no clipboard API —
      // the command is still there to read and type, so fail silently.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? t.settings.common.copied : t.settings.common.copy}
      aria-label={`${t.settings.common.copy}: ${command}`}
      className={`group inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1 font-mono text-[12.5px] text-foreground transition-colors hover:bg-muted/70 ${className}`}
    >
      <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{command}</span>
      {copied ? (
        <Check className="size-3.5 shrink-0 text-success" />
      ) : (
        <span className="text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {t.settings.common.copy}
        </span>
      )}
    </button>
  );
}
