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

export type GitHubMode = "cloud" | "desktop" | "cli" | "token";

interface GitHubContextValue {
  /* Connection */
  connected: boolean;
  connecting: boolean;
  loading: boolean;
  mode: GitHubMode;
  selfHosted: boolean;
  deployMode: string;
  connect: () => Promise<void>;

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
}

export type CliAction =
  | { type: "terminal"; command: string; message: string }
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
  initialSelfHosted?: boolean;
  initialDeployMode?: string;
}

export function GitHubProvider({ children, initialSelfHosted = true, initialDeployMode = "docker" }: GitHubProviderProps) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<GitHubMode>("cloud");
  const [selfHosted, setSelfHosted] = useState(initialSelfHosted);
  const [deployMode] = useState(initialDeployMode);
  const [cliAction, setCliAction] = useState<CliAction | null>(null);
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
      if (res?.mode) {
        // Map backend mode to frontend mode type
        const m = res.mode as string;
        if (m === "app") setMode("cloud");
        else if (m === "cli") setMode("cli");
        else if (m === "token") setMode("token");
        else if (m === "oauth") setMode("desktop");
        else setMode(m as GitHubMode);
      }
      if (res?.selfHosted !== undefined) setSelfHosted(res.selfHosted);
      if (res?.status?.connected && res.accounts?.length > 0) {
        setConnected(true);
        setCliAction(null);
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
    setCliAction(null);

    try {
      const res = await githubApi.connect();

      // Already connected — just refresh
      if (res?.connected) {
        setConnecting(false);
        refresh();
        return;
      }

      switch (res?.flow) {
        case "redirect": {
          // Backend gave us a URL — open in popup / system browser
          const handle = openAuthWindow();
          handle.navigate(res.url);
          handle.onClose(() => {
            setTimeout(() => {
              setConnecting(false);
              refresh();
            }, 1000);
          });
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

        case "terminal":
          // Show terminal instruction
          setCliAction({ type: "terminal", command: res.command, message: res.message });
          setConnecting(false);
          return;

        default:
          setConnecting(false);
      }
    } catch {
      setConnecting(false);
    }
  }, [refresh]);

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
        }
      } catch { /* keep polling */ }
    }, interval);

    return () => clearInterval(timer);
  }, [cliAction, refresh]);

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
        selfHosted,
        deployMode,
        connect,
        cliAction,
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
