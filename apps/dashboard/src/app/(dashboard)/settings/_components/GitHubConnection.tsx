"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Github,
  ExternalLink,
  Unplug,
  RefreshCw,
  Download,
  Terminal,
  Key,
  KeyRound,
  Loader2,
  ChevronDown,
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
import { githubApi, settingsApi, getApiErrorMessage } from "@/lib/api";

import { SettingsSection } from "./SettingsSection";
import { useI18n, interpolate } from "@/components/i18n-provider";

const EMPTY_STATE: GitHubConnectionState = {
  sources: { openshipApp: { connected: false }, ghCli: { available: false } },
  primary: null,
};

/**
 * What the backend says is offerable here. Mirrors GitHubCapabilities in
 * apps/api/src/modules/github/github.capabilities.ts.
 *
 * The dashboard deliberately derives NOTHING about availability itself anymore —
 * it used to branch on `selfHosted` / `deployMode` and drifted from the resolver
 * (a forwarding toggle that could never take effect, a Cloud App row on a box with
 * no cloud link). Absent (older API / failed probe) → `null`, and the UI falls back
 * to showing the methods it can prove are safe.
 */
type MethodKind = "device" | "token" | "app" | "ssh-key" | "forwarding";
interface Capabilities {
  platform: "saas" | "selfhosted";
  desktop: boolean;
  primary: MethodKind | null;
  methods: Array<{
    kind: MethodKind;
    available: boolean;
    configured: boolean;
    requiresCloud?: boolean;
    unavailableReason?: string;
  }>;
}

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
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  // "Forward my git identity to build servers" (Settings → Clone credentials).
  // DESKTOP only — `relayConfigEligible` requires isDesktop. When on, the stored
  // identity (device sign-in or pasted token) is forwarded to remote build hosts
  // over the SSH tunnel, so it authenticates remote server clones too.
  const [forwardGit, setForwardGit] = useState(false);
  // "Change method" disclosure for the connected state. Controlled (not native
  // <details>) so the toggle sits inline next to Disconnect in one flex row and
  // the method list drops full-width below, instead of a w-full <details> that
  // wraps the toggle onto its own line under the button.
  const [showChangeMethod, setShowChangeMethod] = useState(false);

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
      setCapabilities((res?.capabilities as Capabilities | undefined) ?? null);
    } catch {
      setState(EMPTY_STATE);
      setAccounts([]);
      setInstallUrl(null);
      setCapabilities(null);
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
  const { selfHosted: isSelfHosted, deployMode } = usePlatform();
  // Backend-declared when we have it. `deployMode` remains only as the pre-load
  // fallback, so a slow /status doesn't flash the wrong affordance.
  const isDesktop = capabilities?.desktop ?? deployMode === "desktop";
  const can = (kind: MethodKind) => {
    const m = capabilities?.methods.find((x) => x.kind === kind);
    // No capabilities payload → fall back to "offer it", matching prior behaviour
    // rather than hiding a working method behind a failed probe.
    return m ? m.available : true;
  };

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

  // ── One-active-method model ────────────────────────────────────────────────
  // GitHub auth is a pick-ONE decision, but this card used to render every path
  // at once: the App CTA, two chips that only navigate elsewhere, a full gh-CLI
  // sub-card with its own header, and a token footnote. Four competing CTAs,
  // three of which left the page. Now: show the method actually in use, and put
  // the rest behind a disclosure.
  const ghConnected = state.sources.ghCli.available;
  const ghLogin = state.sources.ghCli.login;
  const anyConnected = appConnected || ghConnected;
  // Which one is doing the work. `primary` is the backend's own resolution, so
  // the badge can't disagree with what clones actually use.
  const activeIsGh = state.primary === "gh-cli";
  // Name the identity by how it was connected. "gh CLI" is only correct for a
  // credential probed off the host's own gh login.
  const ghMethod = state.sources.ghCli.method ?? "host-cli";
  const ghMethodLabel =
    ghMethod === "token"
      ? t.settings.github.methodToken
      : ghMethod === "device"
        ? t.settings.github.methodDevice
        : t.settings.github.methodHostCli;
  // Where this credential is administered ON GITHUB — the only place it can
  // actually be revoked. A PAT lives in the token settings; a device sign-in and
  // the host's gh login are both OAuth grants under authorized apps.
  const ghManageUrl =
    ghMethod === "token"
      ? "https://github.com/settings/tokens"
      : "https://github.com/settings/applications";
  const ghManageLabel =
    ghMethod === "token"
      ? t.settings.github.manageTokensOnGithub
      : t.settings.github.manageAccessOnGithub;
  // A credential is stored but unusable. Distinct from "nothing connected": the
  // card used to render the connect chooser for both, so a revoked token looked
  // exactly like a fresh install while every clone using it failed.
  const ghProblem = state.sources.ghCli.problem;

  return (
    <SettingsSection
      icon={Github}
      title={t.settings.github.title}
      description={
        loading
          ? t.settings.github.checkingConnection
          : anyConnected
            ? interpolate(t.settings.github.activeVia, {
                method: activeIsGh ? ghMethodLabel : t.settings.github.methodApp,
              })
            : t.settings.github.pickMethod
      }
      iconBg="bg-foreground/5"
      iconColor="text-foreground"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          {t.settings.github.checkingConnection}
        </div>
      ) : !anyConnected && cliAction ? (
        /* A login is in flight. It's the only actionable thing on the card, so it
           replaces the chooser entirely instead of appearing underneath it. */
        <DeviceFlowPanel cliAction={cliAction} onRefresh={() => void loadStatus(true)} isDesktop={isDesktop} />
      ) : anyConnected ? (
        <div className="space-y-4">
          {/* The identity that is actually authorizing clones, first. */}
          {ghConnected && (
            <ActiveIdentity
              icon={Terminal}
              label={ghLogin ? `@${ghLogin}` : ghMethodLabel}
              avatarUrl={state.sources.ghCli.avatarUrl}
              method={ghMethodLabel}
              active={activeIsGh}
              // Forwarding is a DESKTOP relay (api: relayConfigEligible requires
              // isDesktop). Passing it on self-hosted told the operator to flip a
              // toggle that can't take effect there; the accurate note for that
              // case is the remote-credential one below.
              forwardEnabled={isDesktop ? forwardGit : undefined}
              remoteNeedsOwnCredential={!isDesktop}
              onManageForward={() => router.push("/settings?tab=tokens")}
            />
          )}

          {appConnected && (
            <div className="space-y-3">
              <ActiveIdentity
                icon={Github}
                label={appLogin ? `@${appLogin}` : t.settings.github.methodApp}
                method={t.settings.github.methodApp}
                active={!activeIsGh}
              />
              {/* Installations the App can actually deploy from. */}
              {hasInstallations && (
                <div className="space-y-2">
                  {appAccounts.map((acct) => (
                    <div
                      key={acct.login}
                      className="flex items-center gap-3 rounded-xl bg-muted/30 px-3.5 py-2.5"
                    >
                      {acct.avatar_url ? (
                        <img src={acct.avatar_url} alt={acct.login} className="size-7 rounded-full" />
                      ) : (
                        <div className="size-7 rounded-full bg-muted flex items-center justify-center">
                          <Github className="size-3.5 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{acct.login}</p>
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
                    className="inline-flex items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <Download className="size-3.5" />
                    {hasInstallations ? t.settings.github.addAccount : t.settings.github.installApp}
                  </a>
                )}
                <a
                  href="https://github.com/settings/installations"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {t.settings.github.manageOnGithub}
                  <ExternalLink className="size-3" />
                </a>
              </div>
            </div>
          )}

          {/* Actions + the switcher. Everything shares ONE flex row; the method list
              expands full-width below — no w-full <details> pushing the toggle onto
              its own line. Order is by weight: switching method and administering the
              credential at GitHub are routine, so they lead; Disconnect is destructive
              and sits at the far end, away from the two links next to it. */}
          <div className="space-y-3">
            <div className="h-px bg-border/40" />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowChangeMethod((v) => !v)}
                aria-expanded={showChangeMethod}
                className="inline-flex items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                {t.settings.github.changeMethod}
                <ChevronDown className={`size-3.5 transition-transform ${showChangeMethod ? "rotate-180" : ""}`} />
              </button>
              {/* Revoking is only possible ON GitHub, so the card has to be able
                  to send the operator there. Shown for the ACTIVE identity, same
                  as Disconnect — the App block carries its own installs link. */}
              {activeIsGh && (
                <a
                  href={ghManageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {ghManageLabel}
                  <ExternalLink className="size-3" />
                </a>
              )}
              <button
                onClick={() =>
                  promptDisconnect(
                    activeIsGh ? "cli" : "oauth",
                    // Name what is being disconnected. This said "GitHub sign-in"
                    // for every gh-side credential, including a pasted token.
                    activeIsGh ? ghMethodLabel : t.settings.github.disconnectAppLabel,
                    activeIsGh ? t.settings.github.ghCli.disconnectBody : t.settings.github.disconnectAppBody,
                  )
                }
                className="ms-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger-bg"
              >
                <Unplug className="size-3.5" />
                {t.settings.github.disconnect}
              </button>
            </div>
            {/* What Disconnect actually does. It clears the credential from this
                instance and sweeps the caches; it cannot and does not revoke
                anything at GitHub, which is a difference the operator has to know
                before assuming a leaked token is dead. */}
            {activeIsGh && (
              <p className="text-xs text-muted-foreground/80 leading-relaxed">
                {t.settings.github.disconnectScopeNote}
              </p>
            )}
            {showChangeMethod && (
              <MethodChooser
                can={can}
                appRequiresCloud={
                  capabilities?.methods.find((m) => m.kind === "app")?.requiresCloud ?? isSelfHosted
                }
                cloudConnected={cloudConnected}
                connecting={connecting}
                showSignIn={!ghConnected}
                showApp={!appConnected}
                onSignIn={() => connect("cli")}
                onConnectApp={() => connect("oauth")}
                onConnectCloud={startCloudConnect}
                onSsh={() => router.push("/servers")}
                onToken={() => router.push("/settings?tab=tokens")}
              />
            )}
          </div>
        </div>
      ) : (
        /* Nothing connected. Signing in with GitHub is the default because it
           needs no app registration, no Openship account and no shell on the box;
           everything else is a deliberate choice behind the disclosure.

           When a credential IS stored and merely failed its check, the chooser
           alone would be a lie by omission — hence the banner above it. */
        <div className="space-y-4">
          {ghProblem && (
            <CredentialProblem
              problem={ghProblem}
              methodLabel={ghMethodLabel}
              checkedAt={state.sources.ghCli.checkedAt}
              manageUrl={ghManageUrl}
              manageLabel={ghManageLabel}
              onRecheck={() => void loadStatus(true)}
            />
          )}
          <MethodChooser
            can={can}
            appRequiresCloud={
              capabilities?.methods.find((m) => m.kind === "app")?.requiresCloud ?? isSelfHosted
            }
            cloudConnected={cloudConnected}
            connecting={connecting}
            showSignIn
            showApp
            primary
            onSignIn={() => connect("cli")}
            onConnectApp={() => connect("oauth")}
            onConnectCloud={startCloudConnect}
            onSsh={() => router.push("/servers")}
            onToken={() => router.push("/settings?tab=tokens")}
          />
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * A stored credential that didn't pass its check.
 *
 * The two cases must not read alike. "rejected" is GitHub refusing the
 * credential — actionable, and clones will keep failing until it's replaced.
 * "unreachable" means we never got an answer, so the credential is probably
 * fine and telling the operator to go revoke it would be actively wrong.
 */
function CredentialProblem(props: {
  problem: "rejected" | "unreachable";
  methodLabel: string;
  checkedAt?: string;
  manageUrl: string;
  manageLabel: string;
  /** Re-run the verify. The card checks on load, but "unreachable" is usually
   *  transient and re-checking beats making the operator reload the page. */
  onRecheck: () => void;
}) {
  const { problem, methodLabel, checkedAt, manageUrl, manageLabel, onRecheck } = props;
  const { t } = useI18n();
  const rejected = problem === "rejected";
  // Locale-formatted and only as precise as it needs to be. Invalid/absent
  // timestamps simply drop the line rather than rendering "Invalid Date".
  const checked = (() => {
    if (!checkedAt) return null;
    const d = new Date(checkedAt);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
  })();

  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 ${
        rejected ? "border border-danger-border bg-danger-bg" : "bg-muted/40"
      }`}
    >
      {rejected ? (
        <KeyRound className="size-4 mt-0.5 shrink-0 text-danger" />
      ) : (
        <KeyRound className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 space-y-1">
        <p className={`text-sm font-medium ${rejected ? "text-danger" : "text-foreground"}`}>
          {interpolate(
            rejected ? t.settings.github.credentialRejected : t.settings.github.credentialUnreachable,
            { method: methodLabel },
          )}
        </p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {rejected
            ? t.settings.github.credentialRejectedImpact
            : t.settings.github.credentialUnreachableImpact}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
          {rejected && (
            <a
              href={manageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline underline-offset-2 hover:text-primary"
            >
              {manageLabel}
              <ExternalLink className="size-3" />
            </a>
          )}
          <button
            type="button"
            onClick={onRecheck}
            className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline underline-offset-2 hover:text-primary"
          >
            <RefreshCw className="size-3" />
            {t.settings.github.ghCli.recheck}
          </button>
          {checked && (
            <span className="text-xs text-muted-foreground/70">
              {interpolate(t.settings.github.credentialCheckedAt, { time: checked })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A connected GitHub identity: who, by which method, and whether it's the one
 * actually authorizing clones. Replaces the old gh-CLI sub-card, whose eight
 * mutually-exclusive prose paragraphs were most of this card's noise — the two
 * that carried real consequences (remote deploys refused; forwarding is what
 * lifts that) survive as a single inline note.
 */
function ActiveIdentity(props: {
  icon: typeof Github;
  label: string;
  method: string;
  active: boolean;
  avatarUrl?: string;
  /** DESKTOP only: identity forwarding is what makes this reach REMOTE builds.
   *  `undefined` = not applicable on this install, so the note is suppressed. */
  forwardEnabled?: boolean;
  onManageForward?: () => void;
  /** Self-hosted: remote builds use each server's OWN credential — forwarding
   *  isn't available, so say what actually applies instead. */
  remoteNeedsOwnCredential?: boolean;
}) {
  const {
    icon: Icon, label, method, active, avatarUrl,
    forwardEnabled, onManageForward, remoteNeedsOwnCredential,
  } = props;
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      {/* One row, one surface: who, how, and whether it's the active credential.
          The badge lives INSIDE the row so it reads as a property of this identity
          rather than a floating label at the card's edge. */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-3.5 py-3">
        {avatarUrl ? (
          <img src={avatarUrl} alt={label} className="size-8 shrink-0 rounded-full" />
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
            <Icon className="size-4 text-muted-foreground" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{label}</p>
          <p className="truncate text-xs text-muted-foreground">{method}</p>
        </div>
        {active && (
          <span
            className="shrink-0 rounded-full bg-success-bg px-2 py-0.5 text-[10.5px] font-medium text-success"
            title={t.settings.github.ghCli.usedForDeploysTitle}
          >
            {t.settings.github.ghCli.usedForDeploys}
          </span>
        )}
      </div>
      {/* The one consequence worth surfacing: this identity authorizes LOCAL
          builds only. How you extend it to remote builds differs by install, so
          exactly one of these renders — never both, never neither-but-wrong.
            desktop     → turn on identity forwarding (the SSH relay)
            self-hosted → give each server its own credential (no relay there) */}
      {forwardEnabled === false && onManageForward && (
        <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
          <span>
            {t.settings.github.forwardOffHint}{" "}
            <button
              type="button"
              onClick={onManageForward}
              className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
            >
              {t.settings.github.ghCli.manageForward}
            </button>
          </span>
        </p>
      )}
      {remoteNeedsOwnCredential && (
        <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
          <span>{t.settings.github.remoteCredentialHint}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The in-flight login. Device flow is the normal case: a code to paste plus a
 * button that opens GitHub. GitHub's device grant returns no pre-filled URL
 * (there is no `verification_uri_complete`), so copy-then-open is genuinely the
 * shortest path — the same thing `gh auth login` does in a terminal.
 *
 * The `terminal` variant is the last-resort fallback for an instance with no
 * device client id at all, and it says "on the server" because that is where the
 * command has to run.
 */
function DeviceFlowPanel(props: { cliAction: CliAction; onRefresh: () => void; isDesktop: boolean }) {
  const { cliAction, onRefresh, isDesktop } = props;
  const { t } = useI18n();

  if (cliAction.type === "token") {
    // `gh auth login` is a desktop-only hint — a VPS runs the API in a container
    // with no `gh` and no shell, so drop it there and keep the token field clean.
    return <TokenForm message={cliAction.message} hint={isDesktop ? cliAction.command : undefined} onSaved={onRefresh} />;
  }

  if (cliAction.type === "device_flow") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t.settings.github.ghCli.deviceHint}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(cliAction.userCode ?? "").catch(() => {})}
            title={t.settings.github.copyCode}
            className="rounded-md bg-muted px-3 py-1.5 font-mono text-base font-bold tracking-widest text-foreground hover:bg-muted/70 transition-colors"
          >
            {cliAction.userCode}
          </button>
          <a
            href={cliAction.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            <ExternalLink className="size-4" />
            {t.settings.github.openGithub}
          </a>
        </div>
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t.settings.github.ghCli.waiting}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground leading-relaxed">{cliAction.message}</p>
      <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
        {cliAction.command}
      </code>
      <button
        onClick={onRefresh}
        className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        <RefreshCw className="size-4" />
        {t.settings.github.ghCli.recheck}
      </button>
    </div>
  );
}

/** Collapsible "other methods" — native <details> so it needs no state. */
function MethodDisclosure(props: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group w-full">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
        {props.summary}
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3">{props.children}</div>
    </details>
  );
}

/**
 * The method list. `primary` renders the recommended path as a real CTA with the
 * rest behind a disclosure; without it (the "change method" case) everything is
 * an equal-weight row, because the operator has already decided to switch.
 */
function MethodChooser(props: {
  /** Backend-declared availability per method — never re-derived here. */
  can: (kind: "device" | "token" | "app" | "ssh-key" | "forwarding") => boolean;
  /** Backend-declared: does the App need an Openship Cloud link on this install? */
  appRequiresCloud: boolean;
  cloudConnected: boolean;
  connecting: boolean;
  showSignIn: boolean;
  showApp: boolean;
  primary?: boolean;
  onSignIn: () => void;
  onConnectApp: () => void;
  onConnectCloud: () => void;
  onSsh: () => void;
  onToken: () => void;
}) {
  const {
    can, appRequiresCloud, cloudConnected, connecting, showSignIn, showApp, primary,
    onSignIn, onConnectApp, onConnectCloud, onSsh, onToken,
  } = props;
  const { t } = useI18n();

  const row = (
    key: string,
    Icon: typeof Github,
    label: string,
    desc: string,
    onClick: () => void,
  ) => (
    <button
      key={key}
      onClick={onClick}
      disabled={connecting}
      className="flex w-full items-start gap-3 rounded-xl bg-muted/30 px-3.5 py-2.5 text-start transition-colors hover:bg-muted/60 disabled:opacity-50"
    >
      <Icon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground leading-relaxed">{desc}</span>
      </span>
    </button>
  );

  // The App needs Openship Cloud on self-hosted (the private key lives in
  // openship.io), so the row's action is cloud-connect until that's done.
  const needsCloudFirst = appRequiresCloud && !cloudConnected;
  const appRow = row(
    "app",
    Github,
    t.settings.github.methodApp,
    needsCloudFirst ? t.settings.github.requiresCloud : t.settings.github.methodAppDesc,
    needsCloudFirst ? onConnectCloud : onConnectApp,
  );

  // Every row is gated on the BACKEND's verdict. A method the resolver would
  // refuse is never rendered, so the UI cannot advertise a dead path.
  const others = [
    ...(showApp && can("app") ? [appRow] : []),
    ...(can("ssh-key")
      ? [row("ssh", KeyRound, t.settings.github.useSshPerServer, t.settings.github.methodSshDesc, onSsh)]
      : []),
    ...(can("token")
      ? [row("pat", Key, t.settings.github.usePat, t.settings.github.methodTokenDesc, onToken)]
      : []),
  ];

  if (!primary) {
    return (
      <div className="space-y-2">
        {showSignIn &&
          can("device") &&
          row("signin", Github, t.settings.github.signIn, t.settings.github.signInDesc, onSignIn)}
        {others}
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      <div className="space-y-2">
        <button
          onClick={onSignIn}
          disabled={connecting}
          className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {connecting ? <Loader2 className="size-4 animate-spin" /> : <Github className="size-4" />}
          {t.settings.github.signIn}
        </button>
        <p className="text-xs text-muted-foreground leading-relaxed">{t.settings.github.signInDesc}</p>
      </div>
      <MethodDisclosure summary={t.settings.github.otherMethods}>
        <div className="space-y-2">{others}</div>
      </MethodDisclosure>
    </div>
  );
}

/**
 * Paste-a-token connect. Shown when the instance has no device client id, which
 * is the case the old UI answered with "run `gh auth login` on the server" — an
 * instruction the operator often cannot follow (the api container has no `gh` and
 * cannot see the host's ~/.config/gh) and shouldn't have to.
 *
 * The server validates scope before storing, so an under-scoped token fails HERE,
 * on the field just typed into, rather than as a confusing clone failure inside a
 * deploy later. `gh auth login` survives as a secondary hint for bare installs
 * that do have the binary — reading its hosts.yml still works.
 */
function TokenForm(props: { message: string; hint?: string; onSaved: () => void }) {
  const { message, hint, onSaved } = props;
  const { t } = useI18n();
  const { connectWithToken } = useGitHub();
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const value = token.trim();
    if (!value || saving) return;
    setSaving(true);
    setError(null);
    try {
      // Shared context, not a bare fetch: this refreshes every consumer, so the
      // importer works without a reload.
      await connectWithToken(value);
      setToken(""); // don't leave the secret in component state after success
      onSaved();
    } catch (err) {
      setError(getApiErrorMessage(err, t.settings.github.tokenSaveFailed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground leading-relaxed">{message}</p>
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
          className="min-w-0 flex-1 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none"
        />
        <button
          onClick={() => void submit()}
          disabled={!token.trim() || saving}
          className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {t.settings.github.tokenConnect}
        </button>
      </div>
      {error && <p className="text-xs text-danger leading-relaxed">{error}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/70">
        <a
          href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Openship"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          {t.settings.github.tokenCreate}
          <ExternalLink className="size-3" />
        </a>
        {hint && (
          <span>
            {t.settings.github.tokenGhHint}{" "}
            <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
              {hint}
            </code>
          </span>
        )}
      </div>
    </div>
  );
}
