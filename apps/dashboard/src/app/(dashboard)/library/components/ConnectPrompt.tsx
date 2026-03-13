"use client";

import React from "react";
import Link from "next/link";
import { Github, Loader2, GitBranch } from "lucide-react";
import type { CliAction } from "@/context/GitHubContext";

/* ── Shared SVG illustration ──────────────────────────────────────── */

function CardStackSvg() {
  return (
    <svg className="absolute inset-0 w-full h-full" viewBox="0 0 260 180" fill="none">
      <rect x="75" y="45" width="130" height="95" rx="14" fill="var(--th-sf-04)" />
      <rect x="65" y="35" width="130" height="95" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
      <rect x="55" y="25" width="130" height="95" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
      <rect x="55" y="25" width="130" height="28" rx="14" fill="var(--th-sf-05)" />
      <circle cx="72" cy="39" r="4" fill="#ef4444" fillOpacity="0.6" />
      <circle cx="84" cy="39" r="4" fill="#eab308" fillOpacity="0.6" />
      <circle cx="96" cy="39" r="4" fill="#22c55e" fillOpacity="0.6" />
      <rect x="70" y="65" width="50" height="5" rx="2.5" fill="var(--th-on-12)" />
      <rect x="70" y="76" width="85" height="4" rx="2" fill="var(--th-on-08)" />
      <rect x="70" y="85" width="65" height="4" rx="2" fill="var(--th-on-08)" />
      <circle cx="210" cy="90" r="22" fill="var(--th-on-05)" />
      <circle cx="210" cy="90" r="16" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
      <path d="M210 82v16M202 90h16" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="30" cy="60" r="4" fill="var(--th-on-10)" />
      <circle cx="40" cy="140" r="6" fill="var(--th-on-08)" />
      <circle cx="230" cy="40" r="3" fill="var(--th-on-12)" />
      <path d="M185 95 Q 192 92 195 90" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />
    </svg>
  );
}

/* ── Connect GitHub prompt ────────────────────────────────────────── */

export function ConnectPrompt({
  connecting,
  onConnect,
  cliAction,
  onRefresh,
}: {
  connecting: boolean;
  onConnect: () => void;
  cliAction: CliAction | null;
  onRefresh: () => void;
}) {
  // Terminal instruction (e.g. `gh auth login` or env var)
  if (cliAction?.type === "terminal") {
    return (
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="px-6 pb-10 text-center">
          <div className="relative mx-auto w-64 h-44">
            <CardStackSvg />
          </div>
          <h3 className="text-lg font-medium text-foreground/80 mb-2">
            Connect GitHub
          </h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto mb-4 leading-relaxed">
            {cliAction.message}
          </p>
          <code className="inline-block px-4 py-2.5 bg-muted rounded-lg text-sm font-mono text-foreground mb-6">
            {cliAction.command}
          </code>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={onRefresh}
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
            >
              Check Connection
            </button>
          </div>
          <p className="text-xs text-muted-foreground/60 mt-6">
            After logging in, click &quot;Check Connection&quot; to continue.
          </p>
        </div>
      </div>
    );
  }

  // CLI: device flow — show verification code
  if (cliAction?.type === "device_flow") {
    return (
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="px-6 pb-10 text-center">
          <div className="relative mx-auto w-64 h-44">
            <CardStackSvg />
          </div>
          <h3 className="text-lg font-medium text-foreground/80 mb-2">
            Enter this code on GitHub
          </h3>
          <code className="inline-block px-6 py-3 bg-muted rounded-lg text-2xl font-mono font-bold tracking-widest text-foreground mb-4">
            {cliAction.userCode}
          </code>
          <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6 leading-relaxed">
            Go to{" "}
            <a
              href={cliAction.verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              {cliAction.verificationUri}
            </a>
            {" "}and enter the code above.
          </p>
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Waiting for authorization…
          </div>
        </div>
      </div>
    );
  }

  // Default: standard connect button
  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-6 pb-10 text-center">
        <div className="relative mx-auto w-64 h-44">
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 260 180" fill="none">
            <rect x="75" y="45" width="130" height="95" rx="14" fill="var(--th-sf-04)" />
            <rect x="65" y="35" width="130" height="95" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
            <rect x="55" y="25" width="130" height="95" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
            <rect x="55" y="25" width="130" height="28" rx="14" fill="var(--th-sf-05)" />
            <circle cx="72" cy="39" r="4" fill="#ef4444" fillOpacity="0.6" />
            <circle cx="84" cy="39" r="4" fill="#eab308" fillOpacity="0.6" />
            <circle cx="96" cy="39" r="4" fill="#22c55e" fillOpacity="0.6" />
            <rect x="70" y="65" width="50" height="5" rx="2.5" fill="var(--th-on-12)" />
            <rect x="70" y="76" width="85" height="4" rx="2" fill="var(--th-on-08)" />
            <rect x="70" y="85" width="65" height="4" rx="2" fill="var(--th-on-08)" />
            <circle cx="85" cy="108" r="9" fill="var(--th-on-05)" stroke="var(--th-on-10)" strokeWidth="1" />
            <path d="M85 102a6 6 0 0 0-1.9 11.7c.3.05.4-.13.4-.3v-1.05c-1.63.35-1.97-.79-1.97-.79a1.55 1.55 0 0 0-.65-.86c-.53-.36.04-.35.04-.35a1.23 1.23 0 0 1 .9.6 1.25 1.25 0 0 0 1.71.49 1.25 1.25 0 0 1 .37-.78c-1.3-.15-2.67-.65-2.67-2.9a2.27 2.27 0 0 1 .6-1.57 2.1 2.1 0 0 1 .06-1.55s.49-.16 1.6.6a5.5 5.5 0 0 1 2.92 0c1.11-.76 1.6-.6 1.6-.6a2.1 2.1 0 0 1 .06 1.55 2.27 2.27 0 0 1 .6 1.57c0 2.26-1.37 2.75-2.68 2.9a1.4 1.4 0 0 1 .4 1.08v1.6c0 .17.1.35.4.3A6 6 0 0 0 85 102z" fill="var(--th-on-20)" />
            <circle cx="210" cy="90" r="22" fill="var(--th-on-05)" />
            <circle cx="210" cy="90" r="16" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
            <path d="M210 82v16M202 90h16" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" />
            <circle cx="30" cy="60" r="4" fill="var(--th-on-10)" />
            <circle cx="40" cy="140" r="6" fill="var(--th-on-08)" />
            <circle cx="230" cy="40" r="3" fill="var(--th-on-12)" />
            <circle cx="245" cy="130" r="5" fill="var(--th-on-06)" />
            <path d="M25 100l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
            <path d="M220 150l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />
            <path d="M185 95 Q 192 92 195 90" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />
          </svg>
        </div>

        <h3 className="text-lg font-medium text-foreground/80 mb-2">
          Connect your GitHub account
        </h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-8 leading-relaxed">
          Link your GitHub account to browse repositories, deploy with one click,
          and get automatic deployments on every push.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={onConnect}
            disabled={connecting}
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {connecting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Connecting…
              </>
            ) : (
              <>
                <Github className="size-4" />
                Connect GitHub
              </>
            )}
          </button>
          <Link
            href="/library?tab=template"
            className="inline-flex items-center gap-2 px-6 py-3 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
          >
            <GitBranch className="size-4" />
            Browse Templates
          </Link>
        </div>

        <p className="text-xs text-muted-foreground/60 mt-6">
          We request read access to your repositories. You can revoke anytime.
        </p>
      </div>
    </div>
  );
}
