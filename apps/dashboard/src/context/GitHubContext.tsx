"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import { githubApi } from "@/lib/api";
import { endpoints } from "@/lib/api/endpoints";
import {
  getApiBaseUrl,
  getApiErrorMessage,
  isAbortError,
  isNetworkError,
} from "@/lib/api/client";
import { openAuthWindow } from "@/utils/authWindow";
import { useToast } from "@/context/ToastContext";
import {
  GITHUB_CONNECT_ERROR_KEY,
  githubConnectErrorMessage,
} from "@/lib/github-connect-error";

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
   *  - "cli" → gh CLI org membership (local-only)
   */
  source?: "app" | "cli";
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
  owner: { login: string; avatar_url: string } | string;
  html_url?: string;
  /**
   * Where this repo was sourced from (cloud-app mode only):
   *   - "app"  → covered by a GitHub App installation. Deployable
   *              anywhere (local + remote) via short-lived install tokens.
   *   - "cli"  → seen by the local gh CLI but NOT covered by an App
   *              installation. Local builds only — remote deploys are
   *              refused by clone-auth (GITHUB_APP_INSTALLATION_REQUIRED).
   *   - "both" → visible via both sources. Same capabilities as "app".
   * Undefined for SaaS mode + legacy code paths (App is the only source).
   */
  source?: "app" | "cli" | "both";
}

/**
 * Canonical GitHub connection state from the backend. Mirrors
 * `GitHubConnectionState` in apps/api/src/modules/github/github.types.ts —
 * the single source of truth for "is GitHub connected? which source is
 * primary?". No `mode` field: the global platform mode lives in
 * PlatformContext (`selfHosted`).
 */
export interface GitHubConnectionState {
  sources: {
    openshipApp: {
      connected: boolean;
      login?: string;
      avatarUrl?: string;
      hasInstallations?: boolean;
    };
    ghCli: {
      available: boolean;
      login?: string;
      avatarUrl?: string;
      /** How it was connected — "host-cli" (probed off the host's gh login),
       *  "device" (browser sign-in) or "token" (pasted PAT). Drives the label and
       *  the first-run consent prompt; absent on older API responses. Also set
       *  when `available` is false but a credential exists (see `problem`). */
      method?: "host-cli" | "device" | "token";
      /** A credential IS stored but can't be used: "rejected" (GitHub returned
       *  401/403 — revoked, expired, scope removed) or "unreachable" (no answer
       *  from GitHub, so the credential may be fine). Absent when nothing is
       *  connected at all — that's the plain connect case, not a fault. */
      problem?: "rejected" | "unreachable";
      /** ISO timestamp of the last verify against GitHub. */
      checkedAt?: string;
    };
  };
  primary: "openship-app" | "gh-cli" | null;
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

export interface GitHubCapabilities {
  platform: "saas" | "selfhosted";
  desktop: boolean;
  primary: "device" | "token" | "app" | "ssh-key" | "forwarding" | null;
  methods: Array<{
    kind: "device" | "token" | "app" | "ssh-key" | "forwarding";
    available: boolean;
    configured: boolean;
    requiresCloud?: boolean;
    unavailableReason?: string;
  }>;
}

export type CliAction =
  | { type: "terminal"; command: string; message: string }
  /** No device client id on this instance — collect a token in the UI instead of
   *  sending the operator to a shell they may not have. `command` is the
   *  secondary `gh auth login` hint for bare installs that do have gh. */
  | { type: "token"; command: string; message: string }
  | { type: "device_flow"; userCode: string; verificationUri: string; expiresIn: number; interval: number };

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

export function GitHubProvider({ children, initialData }: GitHubProviderProps) {
  // Note: setSelfHosted is no longer driven from this context — the
  // global platform mode is owned by PlatformContext and read from
  // env.CLOUD_MODE during the initial dashboard layout. We deliberately
  // don't shadow it here.
  const { showToast } = useToast();
  const [state, setState] = useState<GitHubConnectionState>(
    initialData?.state ?? EMPTY_STATE,
  );
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(!initialData);

  const [cliAction, setCliAction] = useState<CliAction | null>(null);
  const [accounts, setAccounts] = useState<GitHubAccount[]>(initialData?.accounts || []);
  const [userLogin, setUserLogin] = useState(
    initialData?.state?.sources?.openshipApp?.login ||
      initialData?.state?.sources?.ghCli?.login ||
      "",
  );
  const [selectedOwner, setSelectedOwnerState] = useState(userLogin);
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

  // Convenience derived from state.primary — every existing call site
  // that read `connected` keeps working.
  const connected = state.primary !== null;

  /* ── Fetch connection info ──────────────────────────────────── */
  const refresh = useCallback(async () => {
    if (inflightRefresh.current) return inflightRefresh.current;
    const work = (async () => {
    // refresh() runs after every connect / disconnect / device-flow completion,
    // so drop the cached /github/status verdict here — the Settings card and
    // library App badge will then re-probe the new connection state instead of
    // serving the stale cached one (covers connect paths that don't go through
    // the Settings card's own force-refresh).
    githubApi.invalidateStatus();
    try {
      const res = await githubApi.getUserHome();
      const nextState: GitHubConnectionState = res?.state ?? EMPTY_STATE;
      setState(nextState);

      if (res?.installUrl) setInstallUrl(res.installUrl);
      else setInstallUrl(null);
      if (res?.capabilities) setCapabilities(res.capabilities as GitHubCapabilities);

      if (nextState.primary !== null) {
        setCliAction(null);
        setAccounts(res.accounts ?? []);
        const primaryLogin =
          nextState.sources.openshipApp.login ??
          nextState.sources.ghCli.login ??
          "";
        setUserLogin(primaryLogin);
        if (!selectedOwner && primaryLogin) {
          setSelectedOwnerState(primaryLogin);
        }
        setRepos(res.repos ?? []);
      } else {
        setAccounts([]);
        setRepos([]);
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
      // Defer transient network/abort errors to the global NetworkErrorHandler;
      // only surface ApiError-shaped failures here.
      if (isAbortError(err) || isNetworkError(err)) return;
      setState(EMPTY_STATE);
      showToast(
        getApiErrorMessage(err, "Couldn't load GitHub data"),
        "error",
        "GitHub",
      );
    } finally {
      setLoading(false);
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

  /* ── Connect GitHub ─────────────────────────────────────────── */
  const connect = useCallback(async (source?: "oauth" | "cli") => {
    setConnecting(true);
    setCliAction(null);

    const finishRedirectFlow = () => {
      setConnecting(false);
      // Surface a link failure the callback page stashed (e.g. the GitHub
      // account is already linked to a different user) — otherwise the flow
      // just silently reports "not connected".
      try {
        const linkError = localStorage.getItem(GITHUB_CONNECT_ERROR_KEY);
        if (linkError) {
          localStorage.removeItem(GITHUB_CONNECT_ERROR_KEY);
          showToast(githubConnectErrorMessage(linkError), "error", "GitHub");
        }
      } catch { /* storage unavailable */ }
      // One immediate + one short follow-up. The immediate call covers
      // the happy path; the 1500ms follow-up covers the race where the
      // popup closes before the SaaS-side cookie/DB write is visible.
      // `refresh()` is in-flight-deduped so a re-entry coalesces.
      void refresh();
      window.setTimeout(() => void refresh(), 1500);
    };

    try {
      const res = await githubApi.connect(source);

      // Already connected - just refresh
      if (res?.connected) {
        setConnecting(false);
        refresh();
        return;
      }

      switch (res?.flow) {
        case "redirect": {
          // Prefer a backend-provided URL when the next step is known
          // (for example, GitHub App installation after OAuth).
          const redirectUrl = res.url ?? `${getApiBaseUrl()}${endpoints.github.connectRedirect}`;
          const handle = openAuthWindow(redirectUrl);
          handle.onClose(finishRedirectFlow);
          return;
        }

        case "device_code":
          // Show verification code inline
          setCliAction({
            type: "device_flow",
            userCode: res.userCode,
            verificationUri: res.verificationUri,
            expiresIn: res.expiresIn,
            interval: res.interval,
          });
          setConnecting(false);
          return;

        case "token":
          // Instance has no device client id — collect a token inline.
          setCliAction({ type: "token", command: res.command, message: res.message });
          setConnecting(false);
          return;

        case "terminal":
          // Show terminal instruction
          setCliAction({ type: "terminal", command: res.command, message: res.message });
          setConnecting(false);
          return;

        default:
          setConnecting(false);
      }
    } catch (err) {
      setConnecting(false);
      if (isAbortError(err) || isNetworkError(err)) return;
      showToast(
        getApiErrorMessage(err, "Failed to connect to GitHub"),
        "error",
        "GitHub",
      );
    }
  }, [refresh, showToast]);

  /* ── Connect with a pasted token ────────────────────────────── */
  const connectWithToken = useCallback(
    async (token: string) => {
      // Throws on an invalid / under-scoped token so the caller can render the
      // server's reason on the field it came from. refresh() drops the cached
      // status and re-pulls, which is what propagates the identity app-wide.
      await githubApi.setInstanceToken(token);
      setCliAction(null);
      await refresh();
    },
    [refresh],
  );

  /* ── Disconnect GitHub ──────────────────────────────────────── */
  const disconnect = useCallback(
    async (source: "oauth" | "cli" | "all" = "all") => {
      try {
        await githubApi.disconnect(source);
        // Always refresh — the canonical state on the backend is now the
        // source of truth, and a per-source disconnect may still leave
        // the other source connected (e.g. cli logged out but the
        // Openship App still installed).
        await refresh();
      } catch (err) {
        if (isAbortError(err) || isNetworkError(err)) return;
        showToast(
          getApiErrorMessage(err, "Failed to disconnect from GitHub"),
          "error",
          "GitHub",
        );
      }
    },
    [refresh, showToast],
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
          refresh();
        } else if (res?.status === "error") {
          setCliAction(null);
          showToast(
            res?.message || res?.error || "GitHub device flow failed",
            "error",
            "GitHub",
          );
        }
      } catch (err) {
        // Keep polling on transient failures. Only surface a non-network
        // ApiError so the user sees terminal problems (e.g. expired code)
        // instead of an interval that silently spins forever.
        if (isAbortError(err) || isNetworkError(err)) return;
        if (err instanceof Error && (err as any).status) {
          showToast(
            getApiErrorMessage(err, "GitHub device flow failed"),
            "error",
            "GitHub",
          );
        }
      }
    }, interval);

    return () => clearInterval(timer);
  }, [cliAction, refresh, showToast]);

  /* ── Auto-detect a completed login ──────────────────────────── */
  // Any pending CLI action (the device flow OR a `gh auth login` the operator ran
  // on the instance) clears the moment the connection lands, so the UI never gets
  // stuck showing a code/command after success.
  useEffect(() => {
    if (connected && cliAction) setCliAction(null);
  }, [connected, cliAction]);

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
      setLoadingRepos(true);
      try {
        // Backend is mode-aware - handles cloud (installation) vs desktop
        // (OAuth). No params → the full set in `data` (+ authoritative counts we
        // don't need here; this context feeds the client-side pickers). A non-2xx
        // (e.g. "not connected") throws ApiError and is handled by the catch.
        const res = await githubApi.getUserRepos(owner);
        setRepos((res?.data ?? []) as GitHubRepo[]);
      } catch (err) {
        setRepos([]);
        if (isAbortError(err) || isNetworkError(err)) {
          setLoadingRepos(false);
          return;
        }
        showToast(
          getApiErrorMessage(err, "Couldn't load repositories"),
          "error",
          "GitHub",
        );
      } finally {
        setLoadingRepos(false);
      }
    },
    [connected, showToast]
  );

  /* ── Owner change → fetch repos ─────────────────────────────── */
  const setSelectedOwner = useCallback(
    (owner: string) => {
      setSelectedOwnerState(owner);
      if (owner && owner !== selectedOwner) {
        fetchReposForOwner(owner);
      }
    },
    [selectedOwner, fetchReposForOwner]
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
    </GitHubContext.Provider>
  );
}
