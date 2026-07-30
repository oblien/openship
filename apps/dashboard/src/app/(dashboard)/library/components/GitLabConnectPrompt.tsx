"use client";

import React from "react";
import Link from "next/link";
import { Gitlab, Loader2, Settings, Key } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

/**
 * Connect-GitLab prompt for the Library page. Simpler than the GitHub
 * ConnectPrompt — GitLab has one credential slot (OAuth or a PAT), no
 * CLI/device-flow states, so this is a single card with an OAuth button
 * and a pointer to the PAT form in Settings.
 */
export function GitLabConnectPrompt({
  connecting,
  onConnect,
  oauthConfigured,
}: {
  connecting: boolean;
  onConnect: () => void;
  oauthConfigured: boolean;
}) {
  const { t } = useI18n();
  const c = t.library.connect;

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-6 py-10 text-center">
        <div className="mx-auto w-16 h-16 rounded-2xl bg-orange-500/10 flex items-center justify-center mb-5">
          <Gitlab className="size-8 text-orange-500" />
        </div>

        <h3 className="text-lg font-medium text-foreground/85 mb-1.5">{c.connectGitlab}</h3>
        <p className="text-sm text-muted-foreground max-w-md mx-auto mb-7 leading-relaxed">
          {c.connectGitlabDesc}
        </p>

        <div className="flex flex-col items-center gap-3">
          {oauthConfigured ? (
            <button
              onClick={onConnect}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {connecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {c.default.connecting}
                </>
              ) : (
                <>
                  <Gitlab className="size-4" />
                  {c.connectGitlab}
                </>
              )}
            </button>
          ) : (
            <Link
              href="/settings"
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all"
            >
              <Key className="size-4" />
              {c.connectWithPat}
            </Link>
          )}
        </div>

        <div className="mt-7">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <Settings className="size-3.5" />
            {c.manageInSettings}
          </Link>
        </div>
      </div>
    </div>
  );
}
