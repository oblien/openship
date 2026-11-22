"use client";

import { useEffect, useState } from "react";
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { GitConnectionStatusRow } from "@/components/git/GitConnectionStatusRow";
import type { GitHubConnectionState } from "@/context/GitHubContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n } from "@/components/i18n-provider";
import { githubApi } from "@/lib/api";

export function GitHubConnectionStatus({
  state,
  selectedOwner,
  selfHosted,
}: {
  state: GitHubConnectionState;
  selectedOwner: string;
  selfHosted: boolean;
}) {
  return selfHosted ? (
    <SelfHostedConnectionStatus state={state} />
  ) : (
    <SaasConnectionStatus state={state} selectedOwner={selectedOwner} />
  );
}

/**
 * SaaS connection card. The App and the user's own token are both usable.
 */
function SaasConnectionStatus({
  state,
  selectedOwner,
}: {
  state: GitHubConnectionState;
  selectedOwner: string;
}) {
  const { t } = useI18n();
  const personal = state.primary === "personal-token";
  const identity = personal ? state.sources.personalToken : state.sources.openshipApp;
  const connected = identity?.connected ?? false;
  return (
    <GitConnectionStatusRow
      icon={personal ? "key" : "github"}
      label={personal ? t.settings.github.methodToken : t.library.sidebar.openshipGithubApp}
      login={connected ? identity?.login : undefined}
      avatarUrl={identity?.avatarUrl}
      sublabel={connected ? selectedOwner : t.library.sidebar.notConnected}
      connected={connected}
    />
  );
}

/**
 * Self-hosted / desktop connection card. The active library source comes first;
 * a rejected local identity remains visible alongside a working App.
 */
function SelfHostedConnectionStatus({ state }: { state: GitHubConnectionState }) {
  const { t } = useI18n();
  const { deployMode } = usePlatform();
  // gh CLI / `gh auth login` is a DESKTOP concept. A VPS runs the API in a
  // container with no `gh` and no shell, so its row must never say "gh CLI" or
  // "Run gh auth login" — it connects with a token (or the App).
  const isDesktop = deployMode === "desktop";
  const cliConnected = state.sources.ghCli.available && !state.sources.ghCli.problem;
  const cliLogin = state.sources.ghCli.login;
  // Name it by how it was actually connected. This row said "gh CLI" for every
  // identity, so a pasted token or a browser sign-in was reported as a gh-CLI
  // connection — which is not what happened and sent people looking for a CLI.
  const cliMethod = state.sources.ghCli.method ?? "host-cli";
  const cliLabel =
    cliMethod === "token"
      ? t.library.sidebar.methodToken
      : cliMethod === "device"
        ? t.library.sidebar.methodDevice
        : t.library.sidebar.ghCli;
  // Primary row, gated on platform: desktop keeps the gh-CLI framing (Terminal +
  // "Run gh auth login"); a VPS shows the real method (never "gh CLI") and a
  // plain "Not connected" instead of a shell instruction it can't follow.
  const primaryIcon =
    cliMethod === "token" ? "key" : isDesktop && cliMethod === "host-cli" ? "terminal" : "github";
  const primaryLabel = isDesktop
    ? cliLabel
    : cliMethod === "device"
      ? t.library.sidebar.methodDevice
      : t.library.sidebar.methodToken;
  // An App fallback is already present in /home. A healthy local identity keeps
  // /home free of cloud requests, so only that path needs a separate App probe.
  const [appStatus, setAppStatus] = useState<
    GitHubConnectionState["sources"]["openshipApp"] | null
  >(null);

  useEffect(() => {
    const knownApp = state.sources.openshipApp;
    if (knownApp.connected) {
      setAppStatus(knownApp);
      return;
    }
    let cancelled = false;
    githubApi
      .getStatusDeduped<{ state: GitHubConnectionState }>()
      .then((res) => {
        if (cancelled) return;
        const app = res?.state?.sources?.openshipApp;
        setAppStatus(app ?? null);
      })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/github/GitHubConnectionStatus");
        // Cloud unreachable / no link — leave the row neutral rather than
        // asserting a false "disconnected".
        if (!cancelled) setAppStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    state.sources.openshipApp.connected,
    state.sources.openshipApp.login,
    state.sources.openshipApp.avatarUrl,
  ]);

  const cliRow = (
    <GitConnectionStatusRow
      key="cli"
      icon={primaryIcon}
      label={primaryLabel}
      login={cliConnected ? cliLogin : undefined}
      avatarUrl={state.sources.ghCli.avatarUrl}
      sublabel={
        cliConnected
          ? undefined
          : isDesktop
            ? t.library.sidebar.runGhAuth
            : t.library.sidebar.notConnected
      }
      connected={cliConnected}
      optional={state.primary !== null && state.primary !== "gh-cli"}
    />
  );
  const appRow = appStatus?.connected ? (
    <GitConnectionStatusRow
      key="app"
      icon="cloud"
      label={t.settings.github.methodApp}
      login={appStatus.login}
      avatarUrl={appStatus.avatarUrl}
      connected
      optional={state.primary !== "openship-app"}
    />
  ) : null;
  const personal = state.sources.personalToken;
  const tokenRow = personal?.connected ? (
    <GitConnectionStatusRow
      key="personal-token"
      icon="key"
      label={t.settings.github.methodToken}
      login={personal.login}
      avatarUrl={personal.avatarUrl}
      connected
      optional={state.primary !== "personal-token"}
    />
  ) : null;

  return (
    <div className="space-y-2.5">
      {tokenRow}
      {state.primary === "openship-app"
        ? [appRow, cliRow]
        : [cliConnected || !tokenRow ? cliRow : null, appRow]}
    </div>
  );
}
