"use client";

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { GITHUB_SOURCES_CHANGED_EVENT, githubApi, settingsApi } from "@/lib/api";
import { endpoints } from "@/lib/api/endpoints";
import { ApiError, getApiErrorMessage, isAbortError, isNetworkError } from "@/lib/api/client";
import { resolveApiNavigationUrl } from "@/lib/api/urls";
import { openAuthWindow } from "@/utils/authWindow";
import { useToast } from "@/context/ToastContext";
import { consumeGitHubConnectError, githubConnectErrorMessage } from "@/lib/github-connect-error";
import type { GitHubCapabilities, GitHubConnectionState, GitHubInstallationSelection, MappedAccount, MappedRepository } from "@repo/contracts";
export type { GitHubCapabilities, GitHubConnectionState } from "@repo/contracts";
import { GitHubInstallationDialog } from "@/components/github/GitHubInstallationPicker";
import { useI18n } from "@/components/i18n-provider";

/* ── Types ────────────────────────────────────────────────────────── */

export interface GitHubAccount {
  login: string;
  avatar_url: string;
  type: "User" | "Organization";
  name?: string;
  /**
   * Where this account came from. Mirrors MappedAccount.source on the
   * backend. The settings GitHub card filters on this to refuse
   * rendering CLI org memberships as App installations.
   *
   *  - "app" → real GitHub App installation
   *  - "cli" → gh CLI org membership
   */
  source?: MappedAccount["source"];
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  description: string;
  private: boolean;
  stars: number;
  stargazers_count?: number;
  forks: number;
  forks_count?: number;
  language: string;
  updated_at: string;
  default_branch: string;
  clone_url?: string;
  owner: { login: string; avatar_url: string } | string;
  html_url?: string;
  /**
   * Which credential source listed this repository (App, CLI, both, or personal
   * token). This is provenance, not a deployment restriction: preflight resolves
   * access for the chosen target, including server credentials and desktop relay.
   */
  source?: MappedRepository["source"];
}

interface GitHubContextValue {
  /** Canonical GitHub connection state. Read this for anything connection-related. */
  state: GitHubConnectionState;
  /** Derived: `state.primary !== null`. Provided as a convenience for the
   *  many existing call sites that just need a "is anything connected" check. */
  connected: boolean;
  connecting: boolean;
  loading: boolean;
  /**
   * Initiate a GitHub connection. `source` discriminates which dual-source
   * card was clicked in cli mode — "oauth" forces the Openship App install
   * flow even when gh CLI is already authenticated. Omit on legacy modes.
   */
  connect: (source?: "oauth" | "cli") => Promise<void>;
  /**
   * Connect with a pasted token. Goes through the SHARED context (not a local
   * fetch inside whichever form was used) so every consumer — the Settings card,
   * the library, the New Project importer — sees the new identity immediately.
   * Doing it locally is what made a fresh token need a page reload before the
   * importer would use it.
   */
  connectWithToken: (token: string) => Promise<void>;
  disconnect: (source?: "oauth" | "cli" | "all") => Promise<void>;

  /* CLI / Device flow */
  cliAction: CliAction | null;

  /* Data */
  accounts: GitHubAccount[];
  userLogin: string;
  selectedOwner: string;
  setSelectedOwner: (owner: string) => void;
  repos: GitHubRepo[];
  loadingRepos: boolean;

  /* Actions */
  refresh: () => Promise<void>;
  fetchReposForOwner: (owner: string) => Promise<void>;

  /* App mode */
  installUrl: string | null;

  /**
   * Backend-declared connect methods (see api github.capabilities.ts). Null until
   * the first /github/home or /github/status resolves, or when an older API doesn't
   * send it — consumers treat null as "no opinion" and fall back to showing what
   * they can prove is safe, never to re-deriving platform policy.
   */
  capabilities: GitHubCapabilities | null;
}

export type CliAction =
  | { type: "terminal"; command: string; message: string }
  /** No device client id on this instance — collect a token in the UI instead of
   *  sending the operator to a shell they may not have. `command` is the
   *  secondary `gh auth login` hint for bare installs that do have gh. */
  | { type: "token"; command: string; message: string }
  | {
      type: "device_flow";
      userCode: string;
      verificationUri: string;
      expiresIn: number;
      interval: number;
    };

const GitHubContext = createContext<GitHubContextValue | undefined>(undefined);

export function useGitHub() {
  const ctx = useContext(GitHubContext);
  if (!ctx) throw new Error("useGitHub must be used within GitHubProvider");
  return ctx;
}

/* ── Provider ─────────────────────────────────────────────────────── */

interface GitHubProviderProps {
  children: React.ReactNode;
  initialData?: any;
}

const EMPTY_STATE: GitHubConnectionState = {
  sources: {
    openshipApp: { connected: false },
    ghCli: { available: false },
  },
  primary: null,
};

function primaryLogin(state: GitHubConnectionState): string {
  if (state.primary === "personal-token") return state.sources.personalToken?.login ?? "";
  if (state.primary === "gh-cli") return state.sources.ghCli.login ?? "";
  return state.sources.openshipApp.login ?? "";
}

function availableOwner(current: string, login: string, accounts: GitHubAccount[], repos: GitHubRepo[]): string {
  const ownersWithRepos = new Set(repos.map((r) =>
    (typeof r.owner === "string" ? r.owner : r.owner?.login)?.toLowerCase(),
  ));
  return accounts.find((a) => a.login.toLowerCase() === current.toLowerCase())?.login
    ?? accounts.find((a) => a.login.toLowerCase() === login.toLowerCase() && ownersWithRepos.has(a.login.toLowerCase()))?.login
    ?? accounts.find((a) => ownersWithRepos.has(a.login.toLowerCase()))?.login
    ?? accounts.find((a) => a.login.toLowerCase() === login.toLowerCase())?.login
    ?? accounts[0]?.login
    ?? login;
}

// OAuth grants and installation nonces are already bounded server-side. This
// client deadline is a UX guard: a callback that cannot close its window must
// never leave every GitHub connect button disabled forever.
const GITHUB_REDIRECT_TIMEOUT_MS = 10 * 60 * 1000;
const GITHUB_REDIRECT_POLL_MS = 2000;

export function GitHubProvider({ children, initialData }: GitHubProviderProps) {
  // Note: setSelfHosted is no longer driven from this context — the
  // global platform mode is owned by PlatformContext and read from
  // env.CLOUD_MODE during the initial dashboard layout. We deliberately
  // don't shadow it here.
  const { showToast } = useToast();
  const { t } = useI18n();
  const [installationSelection, setInstallationSelection] = useState<GitHubInstallationSelection | null>(null);
  const [state, setState] = useState<GitHubConnectionState>(initialData?.state ?? EMPTY_STATE);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(!initialData);

  const [cliAction, setCliAction] = useState<CliAction | null>(null);
  const [accounts, setAccounts] = useState<GitHubAccount[]>(initialData?.accounts || []);
  const [userLogin, setUserLogin] = useState(primaryLogin(initialData?.state ?? EMPTY_STATE));
  const [selectedOwner, setSelectedOwnerState] = useState(() => availableOwner("", userLogin, initialData?.accounts ?? [], initialData?.repos ?? []));
  const [repos, setRepos] = useState<GitHubRepo[]>(initialData?.repos || []);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [installUrl, setInstallUrl] = useState<string | null>(initialData?.installUrl || null);
  const [capabilities, setCapabilities] = useState<GitHubCapabilities | null>(
    initialData?.capabilities ?? null,
  );
  const initRef = useRef(false);
  // In-flight refresh promise — multiple triggers (mount effect,
  // connect-flow follow-ups, pollConnect tick, etc.) collapse to ONE
  // network call instead of stacking 3+ /github/home requests per
  // open. Each /github/home call fans out to 3 cloud bridge calls
  // (user-status, installations, install-url) on the API side, so
  // dedup is load-bearing for the SaaS request rate.
  const inflightRefresh = useRef<Promise<void> | null>(null);
  const refreshRequest = useRef(0);
  const repoRequest = useRef(0);
  // A state update does not synchronously disable every connect trigger. Guard
  // the operation itself so a double click cannot mint two OAuth/install flows.
  const connectInFlight = useRef(false);
  const cancelConnect = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelConnect.current?.(), []);

  // Convenience derived from state.primary — every existing call site
  // that read `connected` keeps working.
  const connected = state.primary !== null;

  /* ── Fetch connection info ──────────────────────────────────── */
  const refresh = useCallback(async (force = false) => {
    if (!force && inflightRefresh.current) return inflightRefresh.current;
    const request = ++refreshRequest.current;
    ++repoRequest.current;
    setLoadingRepos(false);
    const work = (async () => {
      // refresh() runs after every connect / disconnect / device-flow completion,
      // so drop the cached /github/status verdict here — the Settings card and
      // library App badge will then re-probe the new connection state instead of
      // serving the stale cached one (covers connect paths that don't go through
      // the Settings card's own force-refresh).
      githubApi.invalidateStatus();
      try {
        const res = await githubApi.getUserHome(force);
        if (request !== refreshRequest.current) return;
        const nextState: GitHubConnectionState = res?.state ?? EMPTY_STATE;
        setState(nextState);

        if (res?.installUrl) setInstallUrl(res.installUrl);
        else setInstallUrl(null);
        if (res?.capabilities) setCapabilities(res.capabilities as GitHubCapabilities);

        if (nextState.primary !== null) {
          setAccounts(res.accounts ?? []);
          const login = primaryLogin(nextState);
          setUserLogin(login);
          setSelectedOwnerState((current) => availableOwner(current, login, res.accounts ?? [], res.repos ?? []));
          setRepos(res.repos ?? []);
        } else {
          setAccounts([]);
          setRepos([]);
          setUserLogin("");
          setSelectedOwnerState("");
        }

        // Surface partial-failure diagnostics from the server. The request
        // succeeded overall but one or more upstream fetches failed silently
        // server-side — show them so the user has a clue why a section is
        // empty (e.g. "App path failed: …" / "CLI repo merge failed: …").
        if (res?.errors && typeof res.errors === "object") {
          const entries = Object.entries(res.errors as Record<string, string>);
          for (const [key, message] of entries) {
            if (!message) continue;
            showToast(`GitHub ${key}: ${message}`, "error", "GitHub");
          }
        }
      } catch (err) {
        if (request !== refreshRequest.current) return;
        // Defer transient network/abort errors to the global NetworkErrorHandler;
        // only surface ApiError-shaped failures here.
        if (isAbortError(err) || isNetworkError(err)) return;
        setState(EMPTY_STATE);
        showToast(getApiErrorMessage(err, "Couldn't load GitHub data"), "error", "GitHub");
      } finally {
        if (request === refreshRequest.current) setLoading(false);
      }
    })();
    inflightRefresh.current = work;
    try {
      await work;
    } finally {
      if (inflightRefresh.current === work) inflightRefresh.current = null;
    }
  }, [showToast]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── On mount ───────────────────────────────────────────────── */
  useEffect(() => {
    // If we have SSR initialData, don't double fetch!
    if (initialData) return;

    if (initRef.current) return;
    initRef.current = true;
    refresh();
  }, [refresh, initialData]);

  useEffect(() => {
    const onSourcesChanged = () => void refresh(true);
    window.addEventListener(GITHUB_SOURCES_CHANGED_EVENT, onSourcesChanged);
    return () => window.removeEventListener(GITHUB_SOURCES_CHANGED_EVENT, onSourcesChanged);
  }, [refresh]);

  /* ── Connect GitHub ─────────────────────────────────────────── */
  const connect = useCallback(
    async (source?: "oauth" | "cli", installation?: GitHubInstallationSelection) => {
      if (connectInFlight.current) return;
      // An earlier popup may have closed before its callback committed. Stop
      // that observer before starting a new attempt, including its late reads.
      cancelConnect.current?.();
      connectInFlight.current = true;
      consumeGitHubConnectError();

      // Reserve the popup while this call still has a browser user gesture. The
      // API decides the actual destination asynchronously; opening it afterwards
      // is routinely blocked by popup protection. Explicit CLI/device flows do
      // not navigate away, so they do not need a window.
      let reservedWindow: ReturnType<typeof openAuthWindow> | null = null;
      setConnecting(true);
      setCliAction(null);
      setInstallationSelection(null);

      let active = true;
      let attemptState: string | undefined;
      let redirectTimeout: number | null = null;
      let pollTimer: number | null = null;
      const cleanup = () => {
        active = false;
        if (redirectTimeout !== null) window.clearTimeout(redirectTimeout);
        if (pollTimer !== null) window.clearTimeout(pollTimer);
        try {
          reservedWindow?.close();
        } catch {
          // A cross-origin window may already be inaccessible or closed.
        }
        if (cancelConnect.current === cleanup) cancelConnect.current = null;
      };
      cancelConnect.current = cleanup;

      const finishConnect = () => {
        connectInFlight.current = false;
        setConnecting(false);
      };
      const finishRedirectFlow = () => {
        if (!active) return;
        finishConnect();
        cleanup();
        githubApi.invalidateStatus();
        // Settings owns an App-specific snapshot; the library's gh-first home
        // response cannot refresh it. Notify every source consumer on completion.
        window.dispatchEvent(new Event(GITHUB_SOURCES_CHANGED_EVENT));
      };
      const finishCallbackError = () => {
        const linkError = consumeGitHubConnectError(undefined, attemptState);
        if (!linkError) return false;
        finishRedirectFlow();
        showToast(githubConnectErrorMessage(linkError), "error", "GitHub");
        return true;
      };

      try {
        reservedWindow = source === "cli" ? null : openAuthWindow();
        const res = installation
          ? { connected: false, flow: "redirect", step: "install", completion: "attempt", url: installation.installUrl, state: installation.state }
          : await githubApi.connect(source);
        if (!active) return;

        // Already connected - just refresh
        if (res?.connected) {
          finishRedirectFlow();
          showToast(t.library.connect.installationPicker.successTitle, "success", "GitHub");
          return;
        }

        switch (res?.flow) {
          case "installations":
            cleanup();
            finishConnect();
            setInstallationSelection(res);
            return;
          case "redirect": {
            attemptState = res.completion === "attempt" ? res.state : undefined;
            const handle = reservedWindow ?? openAuthWindow();
            reservedWindow = handle;
            if (handle.blocked) {
              finishConnect();
              cleanup();
              showToast(
                "Your browser blocked the GitHub sign-in window. Allow pop-ups and try again.",
                "error",
                "GitHub",
              );
              return;
            }

            // A backend URL may be absolute (github.com / cloud handoff) or an
            // API-root path. Resolve the latter against the real API mount, not
            // window.location — app.openship.io/api/... is a dashboard 404.
            const redirectUrl = resolveApiNavigationUrl(
              typeof res.url === "string" ? res.url : endpoints.github.connectRedirect,
            );
            let checking = false;
            let lastError: string | null = null;
            const checkCompletion = async () => {
              if (!active || checking) return;
              if (pollTimer !== null) window.clearTimeout(pollTimer);
              if (finishCallbackError()) return;
              checking = true;
              try {
                if (res.completion === "attempt") {
                  if (!res.state) throw new Error("GitHub did not return a connection attempt. Start again.");
                  const progress = await githubApi.pollConnect(res.state);
                  if (!active) return;
                  lastError = null;
                  if (progress.status === "complete") {
                    finishRedirectFlow();
                    showToast(t.library.connect.installationPicker.successTitle, "success", "GitHub");
                  }
                  else if (progress.status === "error") {
                    finishRedirectFlow();
                    showToast(progress.error || "GitHub connection failed. Please try again.", "error", "GitHub");
                  }
                  return;
                }
                const status = await githubApi.getStatus({ includeInstallUrl: false });
                if (!active) return;
                lastError = null;
                const app = status?.state?.sources?.openshipApp;
                // OAuth identity alone is not installed repository access. The
                // engine declares whether this redirect ends at OAuth or after
                // installation; a local CLI identity satisfies neither step.
                if (app?.connected && (res.step === "oauth" || app.hasInstallations === true)) {
                  finishRedirectFlow();
                }
              } catch (error) {
                if (!active) return;
                lastError = getApiErrorMessage(error, "Could not check the GitHub connection.");
                if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
                  finishConnect();
                  cleanup();
                  showToast(lastError, "error", "GitHub");
                }
              } finally {
                checking = false;
                if (active)
                  pollTimer = window.setTimeout(
                    () => void checkCompletion(),
                    GITHUB_REDIRECT_POLL_MS,
                  );
              }
            };
            handle.onClose(() => {
              if (!active) return;
              // Closing a popup (or returning to Electron) allows another
              // attempt, but is not proof that GitHub finished. Keep observing:
              // focus and cross-origin window isolation can arrive BEFORE the
              // installation callback. A new attempt cancels this observer.
              finishConnect();
              void checkCompletion();
            });
            handle.navigate(redirectUrl);
            pollTimer = window.setTimeout(() => void checkCompletion(), GITHUB_REDIRECT_POLL_MS);
            redirectTimeout = window.setTimeout(() => {
              if (!active) return;
              finishConnect();
              cleanup();
              showToast(
                  lastError
                    ? `Could not confirm the GitHub connection: ${lastError}`
                    : "GitHub connection was not confirmed. Finish authorization and repository access in the GitHub window, then try again.",
                  "error",
                  "GitHub",
                );
            }, GITHUB_REDIRECT_TIMEOUT_MS);
            return;
          }

          case "device_code":
            cleanup();
            // Show verification code inline
            setCliAction({
              type: "device_flow",
              userCode: res.userCode,
              verificationUri: res.verificationUri,
              expiresIn: res.expiresIn,
              interval: res.interval,
            });
            finishConnect();
            return;

          case "token":
            cleanup();
            // Instance has no device client id — collect a token inline.
            setCliAction({ type: "token", command: res.command, message: res.message });
            finishConnect();
            return;

          case "terminal":
            cleanup();
            // Show terminal instruction
            setCliAction({ type: "terminal", command: res.command, message: res.message });
            finishConnect();
            return;

          default:
            throw new Error("GitHub returned an incomplete connection response. Try again or use a personal token.");
        }
      } catch (err) {
        if (!active) return;
        cleanup();
        finishConnect();
        showToast(getApiErrorMessage(err, "Failed to connect to GitHub"), "error", "GitHub");
      }
    },
    [refresh, showToast, t],
  );

  /* ── Connect with a pasted token ────────────────────────────── */
  const cancelPendingConnect = useCallback(() => {
    cancelConnect.current?.();
    connectInFlight.current = false;
    setConnecting(false);
  }, []);

  const connectWithToken = useCallback(
    async (token: string) => {
      cancelPendingConnect();
      // Throws on an invalid / under-scoped token so the caller can render the
      // server's reason on the field it came from. refresh() drops the cached
      // status and re-pulls, which is what propagates the identity app-wide.
      const methods: GitHubCapabilities | undefined = capabilities ?? (await githubApi.getStatus({ includeInstallUrl: false }))?.capabilities;
      const tokenMethod = methods?.methods.find((method) => method.kind === "token");
      if (tokenMethod?.available === false) throw new Error(tokenMethod.unavailableReason || "Token connection isn't available for this account.");
      if (tokenMethod?.credentialScope === "user" || methods?.platform === "saas") {
        await settingsApi.updateCloneCredentials({ token, asDefault: true });
      } else if (methods?.platform === "selfhosted") {
        await githubApi.setInstanceToken(token);
      } else throw new Error("Could not load GitHub connection options. Refresh and try again.");
      setCliAction(null);
      await refresh(true);
    },
    [cancelPendingConnect, refresh, capabilities],
  );

  /* ── Disconnect GitHub ──────────────────────────────────────── */
  const disconnect = useCallback(
    async (source: "oauth" | "cli" | "all" = "all") => {
      try {
        cancelPendingConnect();
        await githubApi.disconnect(source);
        // Always refresh — the canonical state on the backend is now the
        // source of truth, and a per-source disconnect may still leave
        // the other source connected (e.g. cli logged out but the
        // Openship App still installed).
        await refresh(true);
      } catch (err) {
        if (isAbortError(err) || isNetworkError(err)) return;
        showToast(getApiErrorMessage(err, "Failed to disconnect from GitHub"), "error", "GitHub");
      }
    },
    [cancelPendingConnect, refresh, showToast],
  );

  /* ── Device flow polling ────────────────────────────────────── */
  useEffect(() => {
    if (cliAction?.type !== "device_flow") return;

    const interval = (cliAction.interval || 5) * 1000;
    const timer = setInterval(async () => {
      try {
        const res = await githubApi.pollConnect();
        if (res?.status === "complete") {
          setCliAction(null);
          refresh(true);
        } else if (res?.status === "error") {
          setCliAction(null);
          showToast(res?.message || res?.error || "GitHub device flow failed", "error", "GitHub");
        }
      } catch (err) {
        // Keep polling on transient failures. Only surface a non-network
        // ApiError so the user sees terminal problems (e.g. expired code)
        // instead of an interval that silently spins forever.
        if (isAbortError(err) || isNetworkError(err)) return;
        if (err instanceof Error && (err as any).status) {
          showToast(getApiErrorMessage(err, "GitHub device flow failed"), "error", "GitHub");
        }
      }
    }, interval);

    return () => clearInterval(timer);
  }, [cliAction, refresh, showToast]);

  /* ── Auto-detect a completed login ──────────────────────────── */
  // Only a terminal login completes through a status probe. A device grant has
  // its own authoritative poll above; a previously connected App or stale CLI
  // identity must not dismiss the new code before the operator authorizes it.
  useEffect(() => {
    if (cliAction?.type === "terminal" && state.sources.ghCli.available) setCliAction(null);
  }, [state.sources.ghCli.available, cliAction]);

  // Terminal (`gh auth login`) has no device code to poll — refresh the status
  // periodically so the UI flips to connected as soon as the operator finishes,
  // instead of requiring a manual "check connection".
  useEffect(() => {
    if (cliAction?.type !== "terminal") return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [cliAction, refresh]);

  /* ── Fetch repos for an owner ───────────────────────────────── */
  const fetchReposForOwner = useCallback(
    async (owner: string) => {
      if (!owner || !connected) return;
      const request = ++repoRequest.current;
      setLoadingRepos(true);
      try {
        // Backend is mode-aware - handles cloud (installation) vs desktop
        // (OAuth). No params → the full set in `data` (+ authoritative counts we
        // don't need here; this context feeds the client-side pickers). A non-2xx
        // (e.g. "not connected") throws ApiError and is handled by the catch.
        const res = await githubApi.getUserRepos(owner);
        if (request !== repoRequest.current) return;
        setRepos((res?.data ?? []) as GitHubRepo[]);
      } catch (err) {
        if (request !== repoRequest.current) return;
        setRepos([]);
        if (isAbortError(err) || isNetworkError(err)) {
          setLoadingRepos(false);
          return;
        }
        showToast(getApiErrorMessage(err, "Couldn't load repositories"), "error", "GitHub");
      } finally {
        if (request === repoRequest.current) setLoadingRepos(false);
      }
    },
    [connected, showToast],
  );

  /* ── Owner change → fetch repos ─────────────────────────────── */
  const setSelectedOwner = useCallback(
    (owner: string) => {
      setSelectedOwnerState(owner);
      if (owner && owner !== selectedOwner) {
        fetchReposForOwner(owner);
      }
    },
    [selectedOwner, fetchReposForOwner],
  );

  return (
    <GitHubContext.Provider
      value={{
        state,
        connected,
        connecting,
        loading,
        capabilities,
        connect,
        connectWithToken,
        disconnect,
        cliAction,
        accounts,
        userLogin,
        selectedOwner,
        setSelectedOwner,
        repos,
        loadingRepos,
        refresh,
        fetchReposForOwner,
        installUrl,
      }}
    >
      {children}
      {installationSelection && <GitHubInstallationDialog selection={installationSelection}
            onClose={() => setInstallationSelection(null)}
            onInstall={() => void connect("oauth", installationSelection)} onRestart={() => void connect("oauth")}
            onComplete={() => {
              setInstallationSelection(null);
              window.dispatchEvent(new Event(GITHUB_SOURCES_CHANGED_EVENT));
              showToast(t.library.connect.installationPicker.successTitle, "success", "GitHub");
            }} />}
    </GitHubContext.Provider>
  );
}
