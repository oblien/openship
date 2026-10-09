"use client";

import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

export function ManagedControlPanel({
  title,
  description,
  icon,
  busy,
  error,
  refresh,
  children,
}: {
  title: string;
  description: string;
  icon: IconName;
  busy: boolean;
  error: string | null;
  refresh: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="min-w-0 space-y-5 rounded-2xl bg-card p-5" aria-busy={busy}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-medium">
            <Icon name={icon} className="size-4 shrink-0" />
            {title}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t.servers.networks.refresh}
          disabled={busy}
          onClick={refresh}
        >
          <Icon name="refresh" className={`size-4 ${busy ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {error && (
        <div role="alert" className="space-y-2 rounded-xl bg-danger/10 p-4 text-sm text-danger">
          <p className="break-words">{error}</p>
          <Button variant="secondary" size="sm" disabled={busy} onClick={refresh}>
            {t.servers.managedControls.retry}
          </Button>
        </div>
      )}
      {children}
    </section>
  );
}

export function ConnectionValue({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const { t } = useI18n();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex min-w-0 items-start gap-2 rounded-xl bg-muted/40 p-3">
        <code
          dir="ltr"
          className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs"
          data-secret={secret || undefined}
        >
          {value}
        </code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`${t.servers.managedControls.copy} ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopyState("copied");
            } catch {
              // diagnostics-ignore: Clipboard denial is shown inline; never report the copied credential.
              setCopyState("failed");
            }
          }}
        >
          <Icon name="copy" className="size-4" />
        </Button>
      </div>
      {copyState !== "idle" && (
        <p role="status" className="text-xs text-muted-foreground">
          {copyState === "copied"
            ? t.servers.managedControls.copied
            : t.servers.managedControls.copyFailed}
        </p>
      )}
    </div>
  );
}
