"use client";

import React from "react";
import { Terminal, ShieldCheck, Monitor, CloudOff } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * First-run consent before listing repos via the local `gh` CLI. The gh path
 * runs entirely on the user's machine (co-located API shelling out to their
 * authenticated `gh`) — nothing hits the cloud — but we still ask once, so the
 * Library doesn't silently enumerate someone's repos on first open. Consent is
 * remembered in localStorage; after "Allow" the repository list renders.
 */
export function GhCliConsent({ login, onAllow }: { login?: string; onAllow: () => void }) {
  const { t } = useI18n();
  const c = t.library.ghCliConsent;

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-6 py-12 text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-info/10 ring-4 ring-info/5">
          <Terminal className="size-6 text-info" />
        </div>
        <h3 className="mb-1.5 text-lg font-medium text-foreground/85">{c.title}</h3>
        <p className="mx-auto mb-6 max-w-md text-sm leading-relaxed text-muted-foreground">
          {login ? interpolate(c.bodyWithLogin, { login }) : c.body}
        </p>

        <ul className="mx-auto mb-7 max-w-sm space-y-2.5 text-start">
          <li className="flex items-start gap-2.5 text-sm text-muted-foreground">
            <CloudOff className="mt-0.5 size-4 shrink-0 text-success" />
            <span>{c.pointNoCloud}</span>
          </li>
          <li className="flex items-start gap-2.5 text-sm text-muted-foreground">
            <Monitor className="mt-0.5 size-4 shrink-0 text-success" />
            <span>{c.pointDesktopOnly}</span>
          </li>
          <li className="flex items-start gap-2.5 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
            <span>{c.pointReadOnly}</span>
          </li>
        </ul>

        <button
          type="button"
          onClick={onAllow}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25"
        >
          <ShieldCheck className="size-4" />
          {c.allow}
        </button>
      </div>
    </div>
  );
}
