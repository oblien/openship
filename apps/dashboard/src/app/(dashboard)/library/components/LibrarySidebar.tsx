"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { githubApi } from "@/lib/api";
import {
  Github,
  Lock,
  Globe,
  BookOpen,
  Zap,
  GitBranch,
  Cloud,
  Terminal,
  Shield,
} from "lucide-react";
import type { GitHubRepo, GitHubConnectionState } from "@/context/GitHubContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n } from "@/components/i18n-provider";

interface LibrarySidebarProps {
  selectedOwner: string;
  repos: GitHubRepo[];
  /** Self-hosted or desktop instance — drives the dual-source UI. */
  selfHosted: boolean;
  /** Canonical GitHub connection state — the only thing this card needs. */
  state: GitHubConnectionState;
  /** Whether the local instance is connected to Openship Cloud. Drives
   *  the "safer remote cloning" CTA card. */
  cloudConnected: boolean;
  /** Authoritative owner-wide counts from the server (GitHub's real totals).
   *  Preferred over counting the `repos` array, which is only the current page
   *  under server-side pagination. Falls back to `repos` when omitted. */
  counts?: { total: number; publicCount: number; privateCount: number };
}

export function LibrarySidebar({
  selectedOwner,
  repos,
  selfHosted,
  state,
  cloudConnected,
  counts,
}: LibrarySidebarProps) {
  const { t } = useI18n();
  const connected = state.primary !== null;
  const total = counts?.total ?? repos.length;
  const publicCount = counts?.publicCount ?? repos.filter((r) => !r.private).length;
  const privateCount = counts?.privateCount ?? repos.filter((r) => r.private).length;

  // NOTE: the library never probes the App. The state here is gh-FIRST (from
  // GET /github/home, which is zero-cloud when gh is logged in), so the App
  // row deliberately shows "Manage in Settings" rather than a definitive
  // connected/disconnected — the App's real status lives on the Settings page
  // (GET /github/status), the ONLY place we pay the cloud round-trip.
  return (
    <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
      {/* ── Connection status ─────────────────────────────────────
          SaaS mode (!selfHosted) → single card: Openship GitHub App.
          Self-hosted/desktop → gh CLI primary + Openship Cloud optional. */}
      {selfHosted ? (
        <SelfHostedConnectionCard
          state={state}
          cloudConnected={cloudConnected}
          selectedOwner={selectedOwner}
        />
      ) : (
        <SaasConnectionCard state={state} selectedOwner={selectedOwner} />
      )}

      {/* Stats (when connected) */}
      {connected && total > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-center gap-2 mb-4">
            <BookOpen className="size-4 text-muted-foreground" />
            <h3 className="font-semibold text-foreground text-sm">{t.library.sidebar.overview}</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <GitBranch className="size-4 text-primary" />
                </div>
                <span className="text-sm text-muted-foreground">{t.library.sidebar.total}</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{total}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Globe className="size-4 text-blue-500" />
                </div>
                <span className="text-sm text-muted-foreground">{t.library.sidebar.public}</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{publicCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
                  <Lock className="size-4 text-orange-500" />
                </div>
                <span className="text-sm text-muted-foreground">{t.library.sidebar.private}</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{privateCount}</span>
            </div>
          </div>
        </div>
      )}

      {/* Quick Tip */}
      <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="size-4 text-primary" />
          <h3 className="font-semibold text-foreground text-sm">{t.library.sidebar.quickTip}</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t.library.sidebar.quickTipDesc}
        </p>
      </div>

    </div>
  );
}

// ─── Connection cards ───────────────────────────────────────────────────────

/**
 * SaaS connection card. In CLOUD_MODE the Openship GitHub App is the
 * only credential source — there's no gh CLI on the SaaS server.
 */
function SaasConnectionCard({
  state,
  selectedOwner,
}: {
  state: GitHubConnectionState;
  selectedOwner: string;
}) {
  const { t } = useI18n();
  const connected = state.sources.openshipApp.connected;
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Github className="size-4 text-muted-foreground" />
        <h3 className="font-semibold text-foreground text-sm">{t.library.sidebar.connection}</h3>
      </div>
      <SourceRow
        icon={Github}
        label={t.library.sidebar.openshipGithubApp}
        sublabel={
          connected
            ? state.sources.openshipApp.login ?? selectedOwner ?? t.library.sidebar.connected
            : t.library.sidebar.notConnected
        }
        connected={connected}
      />
    </div>
  );
}

/**
 * Self-hosted / desktop connection card. Per the architecture rules:
 *   - gh CLI is the PRIMARY source of truth for listing.
 *   - Openship Cloud App is the OPTIONAL secondary source that mints
 *     safer short-lived install tokens for remote cloning.
 *
 * Both rows read straight from the canonical state — no derivation,
 * no parallel booleans, no suppression-flag handling in the UI.
 */
function SelfHostedConnectionCard({
  state,
}: {
  state: GitHubConnectionState;
  cloudConnected: boolean;
  selectedOwner: string;
}) {
  const { t } = useI18n();
  const { deployMode } = usePlatform();
  // gh CLI / `gh auth login` is a DESKTOP concept. A VPS runs the API in a
  // container with no `gh` and no shell, so its row must never say "gh CLI" or
  // "Run gh auth login" — it connects with a token (or the App).
  const isDesktop = deployMode === "desktop";
  const cliConnected = state.sources.ghCli.available;
  const cliLogin = state.sources.ghCli.login;
  // Name it by how it was actually connected. This row said "gh CLI" for every
  // identity, so a pasted token or a browser sign-in was reported as a gh-CLI
  // connection — which is not what happened and sent people looking for a CLI.
  const cliMethod = state.sources.ghCli.method ?? "host-cli";
  const cliLabel =
    cliMethod === "token"
      ? t.library.sidebar.methodToken
      : cliMethod === "device"
        ? t.library.sidebar.methodDevice
        : t.library.sidebar.ghCli;
  // Primary row, gated on platform: desktop keeps the gh-CLI framing (Terminal +
  // "Run gh auth login"); a VPS shows the real method (never "gh CLI") and a
  // plain "Not connected" instead of a shell instruction it can't follow.
  const primaryIcon = isDesktop ? Terminal : Github;
  const primaryLabel = isDesktop
    ? cliLabel
    : cliMethod === "device"
      ? t.library.sidebar.methodDevice
      : t.library.sidebar.methodToken;
  const primarySublabel = cliConnected
    ? `@${cliLogin}`
    : isDesktop
      ? t.library.sidebar.runGhAuth
      : t.library.sidebar.notConnected;

  // App status is NOT part of the gh-first `state` (GET /github/home is
  // zero-cloud by design). To show the REAL App connection without slowing the
  // library, we fetch GET /github/status once on mount — non-blocking, so the
  // card renders immediately from gh state and the App row resolves a beat
  // later. `null` = still checking. This is the one place in the library that
  // pays the cloud round-trip, and only for this secondary row.
  const [appStatus, setAppStatus] = useState<{ connected: boolean; login?: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    githubApi
      .getStatusDeduped<any>()
      .then((res) => {
        if (cancelled) return;
        const app = res?.state?.sources?.openshipApp;
        setAppStatus({ connected: Boolean(app?.connected), login: app?.login ?? null });
      })
      .catch(() => {
        // Cloud unreachable / no link — leave the row neutral rather than
        // asserting a false "disconnected".
        if (!cancelled) setAppStatus({ connected: false, login: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const appSublabel =
    appStatus === null
      ? t.library.sidebar.checking
      : appStatus.connected
        ? appStatus.login ? `@${appStatus.login}` : t.library.sidebar.connected
        : t.library.sidebar.notConnectedManage;

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Github className="size-4 text-muted-foreground" />
        <h3 className="font-semibold text-foreground text-sm">{t.library.sidebar.connection}</h3>
      </div>

      <div className="space-y-2.5">
        {/* PRIMARY: the instance's own GitHub identity (gh CLI on desktop; a
            token on a VPS — never gh-CLI framing there). */}
        <SourceRow
          icon={primaryIcon}
          label={primaryLabel}
          sublabel={primarySublabel}
          connected={cliConnected}
          tone="primary"
        />

        {/* SECONDARY: Openship Cloud App — rendered ONLY when it is actually
            connected. A permanent "Openship Cloud App · Not connected" row on a
            self-hosted install is an advert, not status: nothing here needs it,
            and sitting next to the working connection it read like something was
            half-configured. Connecting it lives in Settings. */}
        {appStatus?.connected && (
          <SourceRow
            icon={Cloud}
            label={t.library.sidebar.openshipCloudApp}
            sublabel={appSublabel}
            connected
            tone="secondary"
          />
        )}
      </div>

      {/* Footnote: the library is gh-driven; App status + install live in Settings */}
      <div className="mt-4 flex items-start gap-2 rounded-xl border border-border/40 bg-muted/30 px-3 py-2.5">
        <Shield className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t.library.sidebar.footnote}{" "}
          <Link
            href="/settings"
            className="font-medium text-foreground hover:underline"
          >
            {t.library.sidebar.manageGithubSettings}
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

function SourceRow({
  icon: Icon,
  label,
  sublabel,
  connected,
  tone = "primary",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sublabel: string;
  connected: boolean;
  tone?: "primary" | "secondary";
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
            connected ? "bg-success-bg" : "bg-muted/60"
          }`}
        >
          <Icon
            className={`size-4 ${
              connected
                ? "text-success"
                : "text-muted-foreground"
            }`}
          />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {label}
            {tone === "secondary" && (
              <span className="ms-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                {t.library.sidebar.optional}
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground truncate">{sublabel}</p>
        </div>
      </div>
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${
          connected
            ? "bg-success-bg text-success"
            : "bg-muted/60 text-muted-foreground"
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            connected ? "bg-success-solid" : "bg-muted-foreground/40"
          }`}
        />
        {connected ? t.library.sidebar.connected : "—"}
      </span>
    </div>
  );
}
