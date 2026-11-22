"use client";

import { Fragment, createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_GIT_PROVIDER, type GitProviderDefinition } from "@repo/core";
import type { IconName } from "@repo/ui/icons";
import type { RepositorySummary } from "@/lib/git-types";
import { useGitLabConnection } from "@/components/gitlab/useGitLabConnection";
import { useGitHubConnection } from "@/components/github/useGitHubConnection";

export interface GitCredentialRecoveryProps {
  owner: string;
  projectId?: string | null;
  serverId?: string | null;
  deployTarget?: "local" | "server" | "cloud" | "cluster" | null;
  buildStrategy?: "local" | "server" | null;
  trigger: "preflight-fail" | "build-fail";
  onBuildLocal(): void;
  onResolved?(): void;
  onDismiss(): void;
}

/** Provider-owned connection UX; repository browsing and deployment stay shared. */
export interface GitConnection {
  definition: GitProviderDefinition;
  icon: IconName;
  activate?(): void;
  dialog?: ReactNode;
  connected: boolean;
  connecting: boolean;
  loading: boolean;
  accounts: Array<{ login: string; avatar_url: string }>;
  selectedOwner: string;
  setSelectedOwner(owner: string): void;
  repos: RepositorySummary[];
  /** When available, the picker can page the complete selected namespace in memory. */
  catalog?: { rows: RepositorySummary[]; refresh(): Promise<void> };
  loadingRepos: boolean;
  installUrl: string | null;
  connect(): Promise<void>;
  cloneCommand?(owner: string, repo: string): Promise<string>;
  credentialRecovery?: {
    matches(code: string): boolean;
    render(props: GitCredentialRecoveryProps): ReactNode;
  };
  connectMore(): void;
  refresh(): Promise<void>;
  fetchReposForOwner(owner: string): Promise<void>;
  consentRequired: boolean;
  renderConnect(props: { header?: ReactNode; onBrowseApps(): void }): ReactNode;
  renderConsent(header?: ReactNode): ReactNode;
  renderManageConnection(props: { onClose(): void }): ReactNode;
  settingsHref: string;
  renderConnectionStatus?(): ReactNode;
}

const GitContext = createContext<{
  connections: GitConnection[];
  selected: string;
  select(provider: string): void;
} | null>(null);

export function GitConnectionsProvider({ children }: { children: ReactNode }) {
  // Each adapter owns its hooks and existing auth state. New providers register
  // their own connection here; consumers never interpret their auth protocol.
  const github = useGitHubConnection();
  const gitlab = useGitLabConnection();
  const connections = [github, gitlab];
  const [selected, setSelected] = useState(DEFAULT_GIT_PROVIDER);
  const select = (id: string) => {
    if (!connections.some((connection) => connection.definition.id === id))
      throw new Error(`Unsupported Git provider: ${id}`);
    setSelected(id);
  };
  return (
    <GitContext.Provider value={{ connections, selected, select }}>
      {children}
      {connections.map(
        (connection) =>
          connection.dialog && (
            <Fragment key={connection.definition.id}>{connection.dialog}</Fragment>
          ),
      )}
    </GitContext.Provider>
  );
}

export function useGit(provider?: string) {
  const context = useContext(GitContext);
  if (!context) throw new Error("useGit must be used within GitConnectionsProvider");
  const connection = context.connections.find(
    (item) => item.definition.id === (provider ?? context.selected),
  );
  const activate = connection?.activate;
  useEffect(() => {
    activate?.();
  }, [activate]);
  if (!connection) throw new Error(`Unsupported Git provider: ${provider}`);
  return { ...connection, connections: context.connections, selectProvider: context.select };
}
