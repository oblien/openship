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
import { openAuthWindow } from "@/utils/authWindow";

const AUTH_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/* ── Types ────────────────────────────────────────────────────────── */

export interface GitHubAccount {
  login: string;
  avatar_url: string;
  type: "User" | "Organization";
  name?: string;
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
}

export type GitHubMode = "cloud" | "desktop";

interface GitHubContextValue {
  /* Connection */
  connected: boolean;
  connecting: boolean;
  loading: boolean;
  mode: GitHubMode;
  connect: () => Promise<void>;

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
}

const GitHubContext = createContext<GitHubContextValue | undefined>(undefined);

export function useGitHub() {
  const ctx = useContext(GitHubContext);
  if (!ctx) throw new Error("useGitHub must be used within GitHubProvider");
  return ctx;
}

/* ── Provider ─────────────────────────────────────────────────────── */

export function GitHubProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<GitHubMode>("cloud");
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [userLogin, setUserLogin] = useState("");
  const [selectedOwner, setSelectedOwnerState] = useState("");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const initRef = useRef(false);

  /* ── Fetch connection info ──────────────────────────────────── */
  const refresh = useCallback(async () => {
    try {
      const res = await githubApi.getUserHome();
      if (res?.mode) setMode(res.mode);
      if (res?.status?.connected && res.accounts?.length > 0) {
        setConnected(true);
        setAccounts(res.accounts);
        setUserLogin(res.status.login);
        if (!selectedOwner) setSelectedOwnerState(res.status.login);
        setRepos(res.repos ?? []);
      } else {
        setConnected(false);
        setAccounts([]);
        setRepos([]);
      }
    } catch {
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── On mount ───────────────────────────────────────────────── */
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    refresh();
  }, [refresh]);

  /* ── Connect GitHub ─────────────────────────────────────────── */
  const connect = useCallback(async () => {
    setConnecting(true);

    // Open auth window immediately (synchronous) so browsers don't block it.
    const handle = openAuthWindow();

    try {
      const res = await githubApi.connect();

      if (res?.mode === "desktop" && !res.needsOAuth) {
        // Desktop: already has OAuth token — nothing to do
        handle.close();
        setConnecting(false);
        refresh();
        return;
      }

      if (res?.needsOAuth) {
        // Both modes: need OAuth first.
        // POST to Better Auth to get the GitHub OAuth redirect URL.
        // callbackURL must be on our own origin (Better Auth validates it).
        // cloud → /auth/callback/install (fetches install URL then redirects)
        // desktop → /auth/callback/close (auto-closes popup)
        const callbackURL =
          res.mode === "cloud"
            ? "/auth/callback/install"
            : "/auth/callback/close";

        const oauthRes = await fetch(
          `${AUTH_API_URL}/api/auth/sign-in/social`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              provider: "github",
              callbackURL,
            }),
          }
        );
        const oauthData = await oauthRes.json();
        if (oauthData?.url) {
          handle.navigate(oauthData.url);
        } else {
          handle.close();
          setConnecting(false);
          return;
        }
      } else if (res?.url) {
        // Cloud mode, has OAuth → go straight to App installation
        handle.navigate(res.url);
      } else {
        handle.close();
        setConnecting(false);
        return;
      }

      handle.onClose(() => {
        setTimeout(() => {
          setConnecting(false);
          refresh();
        }, 1000);
      });
    } catch {
      handle.close();
      setConnecting(false);
    }
  }, [refresh]);

  /* ── Fetch repos for an owner ───────────────────────────────── */
  const fetchReposForOwner = useCallback(
    async (owner: string) => {
      if (!owner || !connected) return;
      setLoadingRepos(true);
      try {
        // Backend is mode-aware — handles cloud (installation) vs desktop (OAuth) 
        const res = await githubApi.getUserRepos(owner);
        if (res && !res.error) {
          const list = Array.isArray(res) ? res : res.data ?? res.repos ?? [];
          setRepos(list);
        } else {
          setRepos([]);
        }
      } catch {
        setRepos([]);
      } finally {
        setLoadingRepos(false);
      }
    },
    [connected]
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
        connected,
        connecting,
        loading,
        mode,
        connect,
        accounts,
        userLogin,
        selectedOwner,
        setSelectedOwner,
        repos,
        loadingRepos,
        refresh,
        fetchReposForOwner,
      }}
    >
      {children}
    </GitHubContext.Provider>
  );
}
