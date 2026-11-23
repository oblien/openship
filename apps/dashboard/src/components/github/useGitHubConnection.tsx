"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { GITHUB_PROVIDER, gitProviderSettingsHref } from "@repo/core";
import { useGitHub } from "@/context/GitHubContext";
import type { GitConnection } from "@/context/GitContext";
import { githubApi } from "@/lib/api/github";
import { GithubDeployCredentialRecovery } from "@/components/deployments/DeployCredentialModal";
import { useCloudResourceKey, useCloudResourceReady } from "@/context/CloudResourceContext";
import { useCloud } from "@/context/CloudContext";
import { usePlatform } from "@/context/PlatformContext";
import { ConnectPrompt } from "@/app/(dashboard)/library/components/ConnectPrompt";
import { GhCliConsent } from "@/app/(dashboard)/library/components/GhCliConsent";
import { GitHubConnectionStatus } from "./GitHubConnectionStatus";

const GH_CLI_CONSENT_KEY = "openship.gh-cli-consent";
const ConnectionDialog = dynamic(
  () =>
    import("@/components/actions/WorkflowGitHubConnection").then(
      (module) => module.WorkflowGitHubConnection,
    ),
  { ssr: false },
);

/** Keep GitHub App/device/PAT behavior in its existing implementation. */
export function useGitHubConnection(): GitConnection {
  const github = useGitHub();
  const resourceKey = useCloudResourceKey();
  const ready = useCloudResourceReady();
  const previousResourceKey = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const previous = previousResourceKey.current;
    previousResourceKey.current = resourceKey;
    if (previous !== null && previous !== resourceKey) void github.refresh();
  }, [resourceKey, ready, github.refresh]);
  const { connected: cloudConnected } = useCloud();
  const { selfHosted } = usePlatform();
  const router = useRouter();
  const [consent, setConsent] = useState(true);
  useEffect(() => {
    setConsent(localStorage.getItem(GH_CLI_CONSENT_KEY) === "1");
  }, []);
  const grantConsent = () => {
    localStorage.setItem(GH_CLI_CONSENT_KEY, "1");
    setConsent(true);
  };
  return {
    definition: GITHUB_PROVIDER,
    icon: "github",
    connected: github.connected,
    connecting: github.connecting,
    loading: github.loading,
    accounts: github.accounts,
    selectedOwner: github.selectedOwner,
    setSelectedOwner: github.setSelectedOwner,
    repos: github.repos,
    loadingRepos: github.loadingRepos,
    installUrl: github.installUrl,
    cloneCommand: async (owner, repo) => (await githubApi.getCloneToken(owner, repo)).command,
    credentialRecovery: {
      matches: (code) =>
        [
          "GITHUB_REMOTE_TOKEN_REQUIRED",
          "GITHUB_APP_INSTALLATION_REQUIRED",
          "GITHUB_CLI_REMOTE_BUILD_REJECTED",
          "GITHUB_TOKEN_REQUIRED",
        ].includes(code),
      render: (props) => <GithubDeployCredentialRecovery {...props} />,
    },
    connect: () => github.connect(),
    refresh: github.refresh,
    fetchReposForOwner: github.fetchReposForOwner,
    connectMore() {
      const app = github.capabilities?.methods.find((method) => method.kind === "app");
      const available = app
        ? app.available && (!app.requiresCloud || cloudConnected)
        : !selfHosted || !!github.installUrl;
      if (available) void github.connect("oauth");
      else router.push(gitProviderSettingsHref(GITHUB_PROVIDER.id));
    },
    consentRequired:
      github.state.primary === "gh-cli" &&
      (github.state.sources.ghCli.method ?? "host-cli") === "host-cli" &&
      !consent,
    renderConnect: (props) => (
      <ConnectPrompt
        {...props}
        connecting={github.connecting}
        onConnect={github.connect}
        cliAction={github.cliAction}
        onRefresh={github.refresh}
        selfHosted={selfHosted}
      />
    ),
    renderConsent: (header) => (
      <GhCliConsent
        header={header}
        login={github.state.sources.ghCli.login}
        onAllow={grantConsent}
      />
    ),
    renderManageConnection: (props) => <ConnectionDialog {...props} />,
    settingsHref: gitProviderSettingsHref(GITHUB_PROVIDER.id),
    renderConnectionStatus: () => (
      <GitHubConnectionStatus state={github.state} selectedOwner={github.selectedOwner} selfHosted={selfHosted} />
    ),
  };
}
