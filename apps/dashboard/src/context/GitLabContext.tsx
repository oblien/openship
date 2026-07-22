"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import { gitlabApi } from "@/lib/api";
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
  GITLAB_CONNECT_ERROR_KEY,
  gitlabConnectErrorMessage,
} from "@/lib/gitlab-connect-error";

/* ── Types ────────────────────────────────────────────────────────── */

export interface GitLabAccount {
  id: number;
  login: string;
  name: string;
  avatarUrl: string | null;
  kind: "user" | "group";
  fullPath: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  owner: string;
  repo: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  description: string | null;
  updatedAt: string;
}

/**
 * Canonical GitLab connection state from the backend. Mirrors
 * `GitLabConnectionState` in apps/api/src/modules/gitlab/gitlab.types.ts.
 * Unlike GitHub, GitLab has a single credential slot per user (OAuth OR
 * PAT — whichever was set last wins) so there's no dual-source shape here.
 */
export interface GitLabConnectionState {
  connected: boolean;
  mode: "oauth" | "pat" | null;
  login: string | null;
  avatarUrl: string | null;
  baseUrl: string;
  oauthConfigured: boolean;
}

interface GitLabContextValue {
  state: GitLabConnectionState;
  connected: boolean;
  connecting: boolean;
  loading: boolean;

  /** OAuth redirect flow. */
  connect: () => Promise<void>;
  /** Personal access token flow — verifies + stores the token. */
  connectWithToken: (token: string) => Promise<{ success: boolean; error?: string }>;
  disconnect: (source?: "oauth" | "pat" | "all") => Promise<void>;

  accounts: GitLabAccount[];
  selectedNamespace: string;
  setSelectedNamespace: (namespace: string) => void;
  projects: GitLabProject[];
  loadingProjects: boolean;

  refresh: () => Promise<void>;
  fetchProjectsForNamespace: (namespace: string) => Promise<void>;
}

const GitLabContext = createContext<GitLabContextValue | undefined>(undefined);

export function useGitLab() {
  const ctx = useContext(GitLabContext);
  if (!ctx) throw new Error("useGitLab must be used within GitLabProvider");
  return ctx;
}

/* ── Provider ─────────────────────────────────────────────────────── */

interface GitLabProviderProps {
  children: React.ReactNode;
}

const EMPTY_STATE: GitLabConnectionState = {
  connected: false,
  mode: null,
  login: null,
  avatarUrl: null,
  baseUrl: "https://gitlab.com",
  oauthConfigured: false,
};

export function GitLabProvider({ children }: GitLabProviderProps) {
  const { showToast } = useToast();
  const [state, setState] = useState<GitLabConnectionState>(EMPTY_STATE);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(true);

  const [accounts, setAccounts] = useState<GitLabAccount[]>([]);
  const [selectedNamespace, setSelectedNamespaceState] = useState("");
  const [projects, setProjects] = useState<GitLabProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const initRef = useRef(false);
  // Coalesce concurrent refreshes (Settings card + Library mounting together).
  const inflightRefresh = useRef<Promise<void> | null>(null);

  const connected = state.connected;

  const refresh = useCallback(async () => {
    if (inflightRefresh.current) return inflightRefresh.current;
    const work = (async () => {
      try {
        const res = await gitlabApi.getHome();
        const nextState: GitLabConnectionState = res?.state ?? EMPTY_STATE;
        setState(nextState);

        if (nextState.connected) {
          setAccounts(res.accounts ?? []);
          const userLogin = nextState.login ?? "";
          if (!selectedNamespace && userLogin) {
            setSelectedNamespaceState(userLogin);
          }
          setProjects(res.projects ?? []);
        } else {
          setAccounts([]);
          setProjects([]);
        }
      } catch (err) {
        if (isAbortError(err) || isNetworkError(err)) return;
        setState(EMPTY_STATE);
        showToast(
          getApiErrorMessage(err, "Couldn't load GitLab data"),
          "error",
          "GitLab",
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

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    refresh();
  }, [refresh]);

  /* ── Connect (OAuth) ────────────────────────────────────────────── */
  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const res = await gitlabApi.connect({ mode: "oauth" });

      if (res?.connected) {
        setConnecting(false);
        await refresh();
        return;
      }

      if (res?.flow === "redirect") {
        // Tag the close-callback URL with `?provider=gitlab` so the shared
        // /auth/callback/close page can route a link failure to the GitLab
        // error key instead of the GitHub one.
        const closeUrl = `${window.location.origin}/auth/callback/close?provider=gitlab`;
        const redirectUrl = `${getApiBaseUrl()}${endpoints.gitlab.connectRedirect}?callbackURL=${encodeURIComponent(closeUrl)}`;
        const handle = openAuthWindow(redirectUrl);
        handle.onClose(() => {
          setConnecting(false);
          try {
            const linkError = localStorage.getItem(GITLAB_CONNECT_ERROR_KEY);
            if (linkError) {
              localStorage.removeItem(GITLAB_CONNECT_ERROR_KEY);
              showToast(gitlabConnectErrorMessage(linkError), "error", "GitLab");
            }
          } catch { /* storage unavailable */ }
          void refresh();
          window.setTimeout(() => void refresh(), 1500);
        });
        return;
      }

      setConnecting(false);
      if (res?.error) {
        showToast(res.error, "error", "GitLab");
      }
    } catch (err) {
      setConnecting(false);
      if (isAbortError(err) || isNetworkError(err)) return;
      showToast(getApiErrorMessage(err, "Failed to connect to GitLab"), "error", "GitLab");
    }
  }, [refresh, showToast]);

  /* ── Connect (Personal Access Token) ────────────────────────────── */
  const connectWithToken = useCallback(
    async (token: string) => {
      setConnecting(true);
      try {
        const res = await gitlabApi.connect({ mode: "pat", token });
        if (res?.success) {
          await refresh();
          return { success: true };
        }
        return { success: false, error: res?.error || "Invalid GitLab personal access token" };
      } catch (err) {
        const message = getApiErrorMessage(err, "Failed to connect to GitLab");
        if (!isAbortError(err) && !isNetworkError(err)) {
          showToast(message, "error", "GitLab");
        }
        return { success: false, error: message };
      } finally {
        setConnecting(false);
      }
    },
    [refresh, showToast],
  );

  /* ── Disconnect ──────────────────────────────────────────────────── */
  const disconnect = useCallback(
    async (source: "oauth" | "pat" | "all" = "all") => {
      try {
        await gitlabApi.disconnect(source);
        await refresh();
      } catch (err) {
        if (isAbortError(err) || isNetworkError(err)) return;
        showToast(getApiErrorMessage(err, "Failed to disconnect from GitLab"), "error", "GitLab");
      }
    },
    [refresh, showToast],
  );

  /* ── Fetch projects for a namespace ─────────────────────────────── */
  const fetchProjectsForNamespace = useCallback(
    async (namespace: string) => {
      if (!connected) return;
      setLoadingProjects(true);
      try {
        const res = await gitlabApi.listProjects(namespace ? { namespace } : undefined);
        if (res && !res.error) {
          setProjects(res.projects ?? []);
        } else {
          setProjects([]);
          if (res?.error) {
            showToast(typeof res.error === "string" ? res.error : "Couldn't load projects", "error", "GitLab");
          }
        }
      } catch (err) {
        setProjects([]);
        if (isAbortError(err) || isNetworkError(err)) {
          setLoadingProjects(false);
          return;
        }
        showToast(getApiErrorMessage(err, "Couldn't load projects"), "error", "GitLab");
      } finally {
        setLoadingProjects(false);
      }
    },
    [connected, showToast],
  );

  const setSelectedNamespace = useCallback(
    (namespace: string) => {
      setSelectedNamespaceState(namespace);
      if (namespace !== selectedNamespace) {
        fetchProjectsForNamespace(namespace);
      }
    },
    [selectedNamespace, fetchProjectsForNamespace],
  );

  return (
    <GitLabContext.Provider
      value={{
        state,
        connected,
        connecting,
        loading,
        connect,
        connectWithToken,
        disconnect,
        accounts,
        selectedNamespace,
        setSelectedNamespace,
        projects,
        loadingProjects,
        refresh,
        fetchProjectsForNamespace,
      }}
    >
      {children}
    </GitLabContext.Provider>
  );
}
