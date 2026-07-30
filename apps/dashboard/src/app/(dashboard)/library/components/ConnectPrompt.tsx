"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Github, Loader2, Settings, ExternalLink, ArrowRight, KeyRound } from "lucide-react";
import { useGitHub, type CliAction } from "@/context/GitHubContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n } from "@/components/i18n-provider";
import { getApiErrorMessage } from "@/lib/api";

/* ── Shared SVG illustration ──────────────────────────────────────── */

/** GitHub mark wired to a few repo cards — "connect your repos". Distinct from
 *  the projects empty-state card stack; neutral --th-* vars throughout. */
function GitHubConnectSvg() {
  return (
    <svg className="absolute inset-0 w-full h-full" viewBox="0 0 240 156" fill="none">
      {/* dashed connection ring */}
      <circle cx="120" cy="74" r="56" stroke="var(--th-bd-subtle)" strokeWidth="1.5" strokeDasharray="3 7" />

      {/* links from the mark out to the repo cards (hidden behind the mark near center) */}
      <path d="M120 74 L184 40" stroke="var(--th-on-10)" strokeWidth="1.5" strokeDasharray="3 4" />
      <path d="M120 74 L198 94" stroke="var(--th-on-10)" strokeWidth="1.5" strokeDasharray="3 4" />
      <path d="M120 74 L44 100" stroke="var(--th-on-10)" strokeWidth="1.5" strokeDasharray="3 4" />

      {/* repo cards */}
      <g>
        <rect x="170" y="30" width="28" height="20" rx="5" fill="var(--th-sf-04)" stroke="var(--th-on-12)" strokeWidth="1" />
        <rect x="175" y="36" width="10" height="2.5" rx="1.25" fill="var(--th-on-20)" />
        <rect x="175" y="41" width="17" height="2.5" rx="1.25" fill="var(--th-on-08)" />
      </g>
      <g>
        <rect x="184" y="84" width="28" height="20" rx="5" fill="var(--th-sf-04)" stroke="var(--th-on-12)" strokeWidth="1" />
        <rect x="189" y="90" width="10" height="2.5" rx="1.25" fill="var(--th-on-20)" />
        <rect x="189" y="95" width="17" height="2.5" rx="1.25" fill="var(--th-on-08)" />
      </g>
      <g>
        <rect x="28" y="90" width="28" height="20" rx="5" fill="var(--th-sf-04)" stroke="var(--th-on-12)" strokeWidth="1" />
        <rect x="33" y="96" width="10" height="2.5" rx="1.25" fill="var(--th-on-20)" />
        <rect x="33" y="101" width="17" height="2.5" rx="1.25" fill="var(--th-on-08)" />
      </g>

      {/* center GitHub mark */}
      <circle cx="120" cy="74" r="30" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1.5" />
      <g transform="translate(120,74) scale(3) translate(-85,-108)">
        <path
          d="M85 102a6 6 0 0 0-1.9 11.7c.3.05.4-.13.4-.3v-1.05c-1.63.35-1.97-.79-1.97-.79a1.55 1.55 0 0 0-.65-.86c-.53-.36.04-.35.04-.35a1.23 1.23 0 0 1 .9.6 1.25 1.25 0 0 0 1.71.49 1.25 1.25 0 0 1 .37-.78c-1.3-.15-2.67-.65-2.67-2.9a2.27 2.27 0 0 1 .6-1.57 2.1 2.1 0 0 1 .06-1.55s.49-.16 1.6.6a5.5 5.5 0 0 1 2.92 0c1.11-.76 1.6-.6 1.6-.6a2.1 2.1 0 0 1 .06 1.55 2.27 2.27 0 0 1 .6 1.57c0 2.26-1.37 2.75-2.68 2.9a1.4 1.4 0 0 1 .4 1.08v1.6c0 .17.1.35.4.3A6 6 0 0 0 85 102z"
          fill="var(--th-on-30)"
        />
      </g>

      {/* sparkles + decorative dots */}
      <path d="M212 60l1.6-3.2 1.6 3.2-3.2-1.6 3.2 0-3.2 1.6z" fill="var(--th-on-12)" />
      <circle cx="26" cy="58" r="3" fill="var(--th-on-10)" />
      <circle cx="208" cy="124" r="4" fill="var(--th-on-06)" />
      <circle cx="58" cy="34" r="3" fill="var(--th-on-12)" />
    </svg>
  );
}

/* ── Connect GitHub prompt ────────────────────────────────────────── */

export function ConnectPrompt({
  connecting,
  onConnect,
  cliAction,
  onRefresh,
  selfHosted,
}: {
  connecting: boolean;
  /** source: "oauth" → Openship App (OAuth+install), "cli" → GitHub device sign-in. */
  onConnect: (source?: "oauth" | "cli") => void;
  cliAction: CliAction | null;
  onRefresh: () => void;
  selfHosted: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  // Which methods to offer is the BACKEND's call (github.capabilities.ts). This
  // component used to branch on `selfHosted` and hardcode the pair of cards, which
  // is how the empty state ended up advertising Openship Cloud on installs that
  // had no use for it. `selfHosted` remains only as the pre-load fallback.
  const { capabilities } = useGitHub();
  const { deployMode } = usePlatform();
  // gh CLI / `gh auth login` is a DESKTOP concept (the operator's own machine has
  // `gh`). A remote self-hosted box (VPS) runs the API in a container with no
  // `gh` and no shell, so it never gets a gh hint — it pastes a token, right here.
  const isDesktop = capabilities?.desktop ?? deployMode === "desktop";
  const can = (kind: "device" | "token" | "app" | "ssh-key" | "forwarding") => {
    const m = capabilities?.methods.find((x) => x.kind === kind);
    return m ? m.available : selfHosted;
  };
  const cardCount = (can("device") ? 1 : 0) + (can("token") || can("ssh-key") ? 1 : 0);

  // No device client id on this instance → collect a token here rather than
  // sending the operator to Settings (or worse, to a shell on the server).
  if (cliAction?.type === "token") {
    return (
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="px-6 pb-10 text-center">
          <div className="relative mx-auto w-64 h-44">
            <GitHubConnectSvg />
          </div>
          <h3 className="text-lg font-medium text-foreground/80 mb-2">
            {t.library.connect.token.title}
          </h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto mb-5 leading-relaxed">
            {cliAction.message}
          </p>
          <div className="max-w-md mx-auto text-start">
            <TokenField onSaved={onRefresh} />
          </div>
        </div>
      </div>
    );
  }

  // Terminal instruction (e.g. `gh auth login` or env var)
  if (cliAction?.type === "terminal") {
    return (
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="px-6 pb-10 text-center">
          <div className="relative mx-auto w-64 h-44">
            <GitHubConnectSvg />
          </div>
          <h3 className="text-lg font-medium text-foreground/80 mb-2">
            {t.library.connect.terminal.title}
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
              {t.library.connect.terminal.checkConnection}
            </button>
          </div>
          <p className="text-xs text-muted-foreground/60 mt-6">
            {t.library.connect.terminal.afterLogin}
          </p>
        </div>
      </div>
    );
  }

  // CLI: device flow - show verification code
  if (cliAction?.type === "device_flow") {
    return (
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="px-6 pb-10 text-center">
          <div className="relative mx-auto w-64 h-44">
            <GitHubConnectSvg />
          </div>
          <h3 className="text-lg font-medium text-foreground/80 mb-2">
            {t.library.connect.deviceFlow.title}
          </h3>
          {/* Click-to-copy: the operator has to paste this into GitHub, and
              GitHub's device grant has no pre-filled URL to link to (there is no
              verification_uri_complete), so copy + open is the shortest path. */}
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(cliAction.userCode ?? "").catch(() => {})}
            title={t.library.connect.deviceFlow.copyCode}
            className="inline-block px-6 py-3 bg-muted rounded-lg text-2xl font-mono font-bold tracking-widest text-foreground mb-4 hover:bg-muted/70 transition-colors"
          >
            {cliAction.userCode}
          </button>
          <p className="text-sm text-muted-foreground max-w-md mx-auto mb-5 leading-relaxed">
            {t.library.connect.deviceFlow.goToSuffix}
          </p>
          <a
            href={cliAction.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 mb-5"
          >
            <ExternalLink className="size-4" />
            {t.library.connect.deviceFlow.openGithub}
          </a>
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t.library.connect.deviceFlow.waiting}
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
          <GitHubConnectSvg />
        </div>

        <h3 className="text-lg font-medium text-foreground/85 mb-1.5">
          {t.library.connect.default.title}
        </h3>
        <p className="text-sm text-muted-foreground max-w-md mx-auto mb-7 leading-relaxed">
          {selfHosted
            ? t.library.connect.default.descSelfHosted
            : t.library.connect.default.descSaas}
        </p>

        {!isDesktop && selfHosted && can("token") ? (
          // VPS / remote self-hosted: the API runs in a container with no `gh`
          // and no shell, so there's no `gh auth login` to hint at and no reason
          // to bounce to Settings — paste a token right here. This IS the empty
          // state: one centered, embedded field.
          <div className="max-w-md mx-auto text-start">
            <TokenField onSaved={onRefresh} />
          </div>
        ) : can("device") || can("token") ? (
          // Desktop: sign in with GitHub (device code, nothing to register), or
          // bring your own credential. A single card centers; two go side by side.
          // Openship Cloud is deliberately absent here — reachable in Settings.
          <div
            className={`grid gap-3 mx-auto text-start ${
              cardCount <= 1 ? "max-w-sm sm:grid-cols-1" : "max-w-xl sm:grid-cols-2"
            }`}
          >
            {can("device") && (
            <button
              onClick={() => onConnect("cli")}
              disabled={connecting}
              className="group rounded-xl border border-primary/40 bg-primary/[0.03] p-4 transition-all hover:border-primary/60 hover:bg-primary/[0.06] disabled:opacity-50"
            >
              <span className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center mb-2.5">
                <Github className="size-[18px] text-foreground/70" />
              </span>
              <p className="text-sm font-medium text-foreground">{t.library.connect.default.ghCli}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {t.library.connect.default.ghCliDesc}
              </p>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-primary mt-3">
                {connecting ? t.library.connect.default.connecting : t.library.connect.default.useGhCli}
                {connecting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowRight className="size-3.5 rtl:rotate-180" />
                )}
              </span>
            </button>
            )}

            {/* Settings owns both halves of "bring your own": the token rows and
                the per-server deploy keys, so one destination covers it. */}
            {(can("token") || can("ssh-key")) && (
            <button
              onClick={() => router.push("/settings?tab=tokens")}
              className="group rounded-xl border border-border/60 bg-card p-4 transition-all hover:border-primary/40 hover:bg-primary/[0.02] text-start"
            >
              <span className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center mb-2.5">
                <KeyRound className="size-[18px] text-foreground/70" />
              </span>
              <p className="text-sm font-medium text-foreground">{t.library.connect.default.byoc}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {t.library.connect.default.byocDesc}
              </p>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-primary mt-3">
                {t.library.connect.default.byocCta}
                <ArrowRight className="size-3.5 rtl:rotate-180" />
              </span>
            </button>
            )}
          </div>
        ) : (
          // SaaS: one path — the Openship GitHub App via OAuth.
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={() => onConnect("oauth")}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {connecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t.library.connect.default.connecting}
                </>
              ) : (
                <>
                  <Github className="size-4" />
                  {t.library.connect.connectGithub}
                </>
              )}
            </button>
          </div>
        )}

        <div className="mt-7">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <Settings className="size-3.5" />
            {t.library.connect.manageInSettings}
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Token entry for the library empty state. Same endpoint and same server-side
 * scope validation as the Settings form — this exists so a fresh instance with no
 * device client id can connect without being bounced to another page, or told to
 * go run `gh auth login` on a box it may not have a shell on.
 */
function TokenField({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const { connectWithToken } = useGitHub();
  const [token, setToken] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const value = token.trim();
    if (!value || saving) return;
    setSaving(true);
    setError(null);
    try {
      await connectWithToken(value);
      setToken(""); // don't keep the secret in state after a success
      onSaved();
    } catch (err) {
      setError(getApiErrorMessage(err, t.library.connect.token.failed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="ghp_…"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none"
        />
        <button
          onClick={() => void submit()}
          disabled={!token.trim() || saving}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {t.library.connect.token.connect}
        </button>
      </div>
      {error && <p className="text-xs text-danger leading-relaxed">{error}</p>}
      <a
        href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Openship"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground underline underline-offset-2"
      >
        {t.library.connect.token.create}
        <ExternalLink className="size-3" />
      </a>
    </div>
  );
}
