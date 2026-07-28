"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Github,
  ExternalLink,
  Unplug,
  RefreshCw,
  Download,
  Terminal,
  Cloud,
  ShieldCheck,
  Key,
  KeyRound,
  Loader2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useGitHub,
  type GitHubConnectionState,
  type GitHubAccount,
  type CliAction,
} from "@/context/GitHubContext";
import { useCloud } from "@/context/CloudContext";
import { useModal } from "@/context/ModalContext";
import { usePlatform } from "@/context/PlatformContext";
import { githubApi, settingsApi } from "@/lib/api";
import { SettingsSection } from "./SettingsSection";
import { useI18n, interpolate } from "@/components/i18n-provider";

const EMPTY_STATE: GitHubConnectionState = {
  sources: { openshipApp: { connected: false }, ghCli: { available: false } },
  primary: null,
};

export function GitHubConnection() {
  // The Settings card owns the App-connection truth. The library context
  // (useGitHub) is now gh-first and does NOT probe the App, so we fetch
  // GET /github/status here — the cloud round-trip for the App badge +
  // installations happens on THIS page only, never on a plain library browse.
  // Actions (connect/disconnect/connecting) still come from the shared context.
  const { connecting, connect: ctxConnect, disconnect: ctxDisconnect, cliAction } = useGitHub();
  const { t } = useI18n();
  const router = useRouter();

  const [state, setState] = useState<GitHubConnectionState>(EMPTY_STATE);
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // "Forward my git identity to build servers" (Settings → Clone credentials).
  // When on, gh CLI is NOT local-only — its identity is forwarded to remote
  // build hosts over SSH, so it authenticates remote server clones too.
  const [forwardGit, setForwardGit] = useState(false);

  const loadStatus = useCallback(async (force = false) => {
    setLoading(true);
    try {
      // Live (no TTL cache) but de-duplicated across concurrent callers (the
      // library App badge shares this in-flight request). `force` bypasses a
      // pre-mutation in-flight after connect/disconnect.
      const res = await githubApi.getStatusDeduped<any>(force);
      setState(res?.state ?? EMPTY_STATE);
      setAccounts(res?.accounts ?? []);
      setInstallUrl(res?.installUrl || null);
    } catch {
      setState(EMPTY_STATE);
      setAccounts([]);
      setInstallUrl(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void settingsApi
      .get()
      .then((r) => setForwardGit(!!r.forwardGitToServer))
      .catch(() => {});
  }, [loadStatus]);

  // Connect/install opens a separate window (OAuth popup or the GitHub App
  // install tab). The connect call returns as soon as that window opens, so
  // the immediate loadStatus below is stale. Arm this flag on click and
  // re-pull the card's own status when the settings window regains focus —
  // i.e. when the connect window closes / the user comes back.
  const pendingConnectRef = useRef(false);
  useEffect(() => {
    const repullIfPending = () => {
      if (!pendingConnectRef.current) return;
      pendingConnectRef.current = false;
      void loadStatus(true);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") repullIfPending();
    };
    window.addEventListener("focus", repullIfPending);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", repullIfPending);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadStatus]);

  // Re-fetch the App status after a connect/disconnect so the card reflects
  // the change without depending on the gh-first library refresh.
  const connect = useCallback(
    async (source?: "oauth" | "cli") => {
      pendingConnectRef.current = true; // re-pull when the connect window closes
      await ctxConnect(source);
      await loadStatus(true);
    },
    [ctxConnect, loadStatus],
  );
  const disconnect = useCallback(
    async (source?: "oauth" | "cli" | "all") => {
      await ctxDisconnect(source);
      await loadStatus(true);
    },
    [ctxDisconnect, loadStatus],
  );

  // Self-hosted needs an active Openship Cloud connection to use the
  // GitHub App at all — the App private key lives in openship.io and
  // self-hosted instances proxy through it. PAT + gh CLI escape hatches
  // don't require cloud.
  const { connected: cloudConnected, startConnect: startCloudConnect } = useCloud();
  const { showModal, hideModal } = useModal();
  const { selfHosted: isSelfHosted } = usePlatform();

  const promptDisconnect = (
    source: "oauth" | "cli" | "all",
    label: string,
    body: string,
  ) => {
    const modalId = showModal({
      title: interpolate(t.settings.github.disconnectTitle, { label }),
      message: body,
      buttons: [
        { label: t.settings.common.cancel, variant: "secondary", onClick: () => hideModal(modalId) },
        {
          label: t.settings.github.disconnect,
          variant: "danger",
          onClick: async () => {
            hideModal(modalId);
            await disconnect(source);
          },
        },
      ],
    });
  };

  // STRICT source-of-truth for the GitHub App card. Read ONLY from
  // state.sources.openshipApp (which the backend computes from the SaaS
  // /api/cloud/github/user-status response in cloud-app mode, or from
  // local OAuth in app mode). NEVER use `connected` from useGitHub() —
  // that's derived from state.primary, which can be "gh-cli" when only
  // the CLI is logged in. In that case `accounts` is a list of CLI org
  // memberships from /user/orgs, NOT App installations — rendering them
  // here would lie about which orgs the App can actually deploy from
  // (they could be completely different sets, and the user would think
  // the App is installed where it isn't).
  const appConnected = state.sources.openshipApp.connected;
  const appLogin = state.sources.openshipApp.login;
  // accounts is only meaningful when the App itself is connected. When
  // primary is "gh-cli" the backend returns CLI orgs in this field
  // (tagged source: "cli") — gate on appConnected AND filter to
  // source: "app" so the App card never surfaces them under any
  // future regression. Backend without the source tag (older response)
  // falls through the `?? true` so we don't black-hole the list when
  // appConnected is genuinely true.
  const appAccounts = appConnected
    ? accounts.filter((acct) => (acct.source ?? "app") === "app")
    : [];
  const hasInstallations = appAccounts.length > 0;

  return (
    <>
      {/* ─── Openship GitHub App card (legacy single-source layout) ─────
          The clean accounts table that was already good. On self-hosted
          + not cloud-connected we swap the "Connect GitHub" CTA for a
          "Connect Openship Cloud" prompt, because the App can't function
          without cloud minting tokens for the local instance.            */}
      <SettingsSection
        icon={Github}
        title={appConnected && appLogin ? interpolate(t.settings.github.titleWithLogin, { login: appLogin }) : t.settings.github.title}
        description={
          appConnected
            ? hasInstallations
              ? appAccounts.length === 1
                ? t.settings.github.connectedOne
                : interpolate(t.settings.github.connectedMany, { count: String(appAccounts.length) })
              : t.settings.github.noInstallations
            : isSelfHosted && !cloudConnected
              ? t.settings.github.requiresCloud
              : t.settings.github.connectPrompt
        }
        iconBg="bg-foreground/5"
        iconColor="text-foreground"
      >
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            {t.settings.github.checkingConnection}
          </div>
        ) : appConnected ? (
          <div className="space-y-4">
            {hasInstallations && (
              <div className="space-y-2">
                {appAccounts.map((acct) => (
                  <div
                    key={acct.login}
                    className="flex items-center gap-3 px-3 py-2 bg-muted/30 rounded-lg border border-border/40"
                  >
                    {acct.avatar_url ? (
                      <img
                        src={acct.avatar_url}
                        alt={acct.login}
                        className="size-7 rounded-full"
                      />
                    ) : (
                      <div className="size-7 rounded-full bg-muted flex items-center justify-center">
                        <Github className="size-3.5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {acct.login}
                      </p>
                    </div>
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">
                      {acct.type === "Organization" ? t.settings.github.orgBadge : t.settings.github.userBadge}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {installUrl && (
                <a
                  href={installUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    pendingConnectRef.current = true; // re-pull when the install tab closes
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
                >
                  <Download className="size-3.5" />
                  {hasInstallations ? t.settings.github.addAccount : t.settings.github.installApp}
                </a>
              )}
              <a
                href="https://github.com/settings/installations"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
              >
                {t.settings.github.manageOnGithub}
                <ExternalLink className="size-3" />
              </a>
              <button
                onClick={() =>
                  promptDisconnect(
                    "oauth",
                    t.settings.github.disconnectAppLabel,
                    t.settings.github.disconnectAppBody,
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger bg-danger-bg hover:bg-danger-bg rounded-lg border border-danger-border transition-colors"
              >
                <Unplug className="size-3.5" />
                {t.settings.github.disconnect}
              </button>
            </div>
          </div>
        ) : isSelfHosted && !cloudConnected ? (
          /* Self-hosted user without cloud — App is unreachable without
             cloud minting tokens for them. Route them through the
             cloud-connect flow first; once cloud is connected the App
             card flips to the standard not-yet-OAuth'd state. */
          <div className="space-y-3.5">
            {/* No explainer paragraph here: the section description already says
                "Requires Openship Cloud — the App is owned by openship.io", and
                repeating it directly underneath was the same sentence twice. */}
            <button
              onClick={startCloudConnect}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 rounded-xl transition-colors"
            >
              <Cloud className="size-4" />
              {t.settings.github.connectCloud}
            </button>

            {/* Escape hatches — clone private repos without cloud. SSH keys
                attach per server (Servers → GitHub); a PAT works everywhere. */}
            <div className="border-t border-border/40 pt-3">
              <p className="text-xs font-medium text-muted-foreground/70 mb-2">
                {t.settings.github.noCloudTitle}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => router.push("/servers")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
                >
                  <KeyRound className="size-3.5" />
                  {t.settings.github.useSshPerServer}
                </button>
                <button
                  onClick={() => router.push("/settings?tab=tokens")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
                >
                  <Key className="size-3.5" />
                  {t.settings.github.usePat}
                </button>
              </div>
              {/* The two buttons above ARE the instruction ("SSH key per server"
                  → Servers, "Access token" → Tokens); the hint line under them
                  only restated it in prose. */}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t.settings.github.linkExplainer}
            </p>
            <button
              onClick={() => connect("oauth")}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 rounded-xl transition-colors disabled:opacity-50"
            >
              {connecting ? (
                <>
                  <RefreshCw className="size-4 animate-spin" />
                  {t.settings.github.connecting}
                </>
              ) : (
                <>
                  <Github className="size-4" />
                  {t.settings.github.connect}
                </>
              )}
            </button>
          </div>
        )}
        {/* ─── gh CLI — a second GitHub auth method, INSIDE this same section
            (self-hosted only). One "GitHub" card, not two cards for the same
            provider. A divider separates it from the App block above. ─── */}
        {isSelfHosted && (
          <div className="mt-4 border-t border-border/50 pt-4">
            <GhCliBlock
              available={state.sources.ghCli.available}
              login={state.sources.ghCli.login}
              avatarUrl={state.sources.ghCli.avatarUrl}
              active={state.primary === "gh-cli"}
              onConnect={() => connect("cli")}
              connecting={connecting && !state.sources.ghCli.available}
              cliAction={cliAction}
              forwardEnabled={forwardGit}
              onManageForward={() => router.push("/settings?tab=tokens")}
              onManageTokens={() => router.push("/settings?tab=tokens")}
            />
          </div>
        )}
      </SettingsSection>
    </>
  );
}

/**
 * gh CLI auth — an inline sub-block rendered INSIDE the GitHub section (not its
 * own card), so there's a single "GitHub" section, not two cards for the same
 * provider. Surfaces the auth state, the "Used for deploys" state, git-identity
 * forwarding, and the connect/disconnect action.
 */
function GhCliBlock(props: {
  available: boolean;
  login?: string;
  avatarUrl?: string;
  active: boolean;
  onConnect: () => void;
  connecting: boolean;
  /** In-progress login the shared context returned: a device code (own client
   *  id) to show inline, or a `gh auth login` instruction for the instance. */
  cliAction: CliAction | null;
  /** "Forward my git identity to build servers" is on → gh CLI authenticates
   *  remote server clones too (not local-only). */
  forwardEnabled: boolean;
  /** Jump to the Clone-credentials section (Tokens tab) that owns the toggle. */
  onManageForward: () => void;
  /** Jump to the Tokens tab (clone tokens / PAT shortcut). */
  onManageTokens: () => void;
}) {
  const { available, login, avatarUrl, active, onConnect, connecting, cliAction, forwardEnabled, onManageForward, onManageTokens } = props;
  const { t } = useI18n();
  return (
      <div className="space-y-3">
        {/* Compact "gh CLI" sub-header — this block lives INSIDE the GitHub
            section (not a separate card), so it uses a small inline header. */}
        <div className="flex items-center gap-2.5">
          <div className="size-8 rounded-lg bg-foreground/5 flex items-center justify-center shrink-0">
            <Terminal className="size-4 text-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground leading-tight">{t.settings.github.ghCli.title}</p>
            {/* When authed, the identity row right below shows the avatar + @login
                + the deploys badge — so "Logged in as @login" here was the same
                line twice. Only the not-authed description earns a subtitle. */}
            {!(available && login) && (
              <p className="text-xs text-muted-foreground truncate">
                {t.settings.github.ghCli.fallbackDesc}
              </p>
            )}
          </div>
        </div>
        {/* Auth identity row when authenticated — the "Used for deploys" badge
            rides on the RIGHT of this same row (right-aligned to the avatar)
            instead of adding its own line above. */}
        {available && login && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 px-3 py-2 bg-muted/30 rounded-lg border border-border/40">
              {avatarUrl ? (
                <img src={avatarUrl} alt={login} className="size-6 rounded-full" />
              ) : (
                <Terminal className="size-4 text-muted-foreground" />
              )}
              <span className="text-sm font-medium text-foreground">@{login}</span>
            </div>
            {active && (
              <span
                className="shrink-0 inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success ring-1 ring-inset ring-success/20"
                title={t.settings.github.ghCli.usedForDeploysTitle}
              >
                {t.settings.github.ghCli.usedForDeploys}
              </span>
            )}
          </div>
        )}

        {/* Active-source warning — remote deploys get refused. Only when
            forwarding is OFF; with forwarding on, gh CLI DOES reach remote. */}
        {active && !forwardEnabled && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground">{t.settings.github.ghCli.activeWarnStrong}</span>{" "}
            {t.settings.github.ghCli.activeWarnRest}
          </p>
        )}
        {/* Cloud-app mode + CLI available: it's a real fallback now.
            clone-auth.ts uses gh CLI for local builds when the App
            doesn't have an installation on the repo's owner (your
            personal forks, side projects, etc). Remote builds still
            route through the App regardless. */}
        {!active && available && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            <ShieldCheck className="size-3.5 inline-block align-text-bottom me-1" />
            {t.settings.github.ghCli.primaryNotePrefix}{" "}
            <span className="text-foreground font-medium">{t.settings.github.ghCli.primaryNoteStrong}</span>{" "}
            {t.settings.github.ghCli.primaryNoteSuffix}
          </p>
        )}
        {/* CLI not yet authed but App is connected — explain why
            setting up gh CLI is still useful. */}
        {!active && !available && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t.settings.github.ghCli.optionalPrefix}{" "}
            <code className="px-1.5 py-0.5 rounded bg-muted/60 text-foreground font-mono text-xs">
              gh auth login
            </code>{" "}
            {t.settings.github.ghCli.optionalSuffix}
          </p>
        )}

        {/* Git-identity forwarding — the access point that turns gh CLI from a
            local-only source into a remote-capable one. Shows the current state
            and links to the toggle (Clone credentials, Tokens tab). */}
        {available && (
          <div className="flex items-start gap-2 rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
            <KeyRound className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              {forwardEnabled
                ? t.settings.github.ghCli.forwardOnNote
                : t.settings.github.ghCli.forwardOffHint}{" "}
              <button
                type="button"
                onClick={onManageForward}
                className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              >
                {t.settings.github.ghCli.manageForward}
              </button>
            </p>
          </div>
        )}

        {/* Login action + in-progress state (not yet authed).
            A pending cliAction renders inline: a device code (operator's own
            GITHUB_CLIENT_ID) with the github.com/login/device link, or the
            `gh auth login` instruction for this instance. Both resolve
            hands-off — the shared context polls and flips this to authed. */}
        {!available &&
          (cliAction ? (
            <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
              {cliAction.type === "device_flow" ? (
                <>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t.settings.github.ghCli.deviceHint}
                  </p>
                  <div className="flex items-center gap-3">
                    <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-base font-bold tracking-widest text-foreground">
                      {cliAction.userCode}
                    </code>
                    <a
                      href={cliAction.verificationUri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary underline underline-offset-2"
                    >
                      {cliAction.verificationUri}
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground leading-relaxed">{cliAction.message}</p>
                  <code className="block rounded-md bg-muted px-3 py-1.5 font-mono text-xs text-foreground">
                    {cliAction.command}
                  </code>
                </>
              )}
              <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t.settings.github.ghCli.waiting}
              </p>
            </div>
          ) : (
            <button
              onClick={onConnect}
              disabled={connecting}
              className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {connecting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Github className="size-4" />
              )}
              {t.settings.github.ghCli.login}
            </button>
          ))}

        {/* Disconnect hint when authed. */}
        {available && (
          <p className="text-xs text-muted-foreground/70 leading-relaxed">
            {t.settings.github.ghCli.disconnectPrefix}{" "}
            <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
              gh auth logout
            </code>{" "}
            {t.settings.github.ghCli.disconnectSuffix}
          </p>
        )}

        {/* Clone-token shortcut — a personal access token is the other way to
            authorize clones (no gh, no cloud). */}
        <p className="text-xs text-muted-foreground/70 leading-relaxed">
          {t.settings.github.ghCli.tokenAltPrefix}{" "}
          <button
            type="button"
            onClick={onManageTokens}
            className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
          >
            {t.settings.github.ghCli.tokenAltLink}
          </button>
        </p>
      </div>
  );
}
