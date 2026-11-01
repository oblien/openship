"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { githubApi, endpoints, getApiErrorMessage } from "@/lib/api";
import { resolveApiNavigationUrl } from "@/lib/api/urls";
import { storeGitHubConnectError } from "@/lib/github-connect-error";
import { closeAuthWindowAfterSuccess } from "@/utils/authWindow";
import type { GitHubInstallationSelection } from "@repo/contracts";
import { GitHubInstallationPicker } from "@/components/github/GitHubInstallationPicker";
import { useI18n } from "@/components/i18n-provider";

/**
 * OAuth callback for cloud mode - after GitHub OAuth completes,
 * fetches the GitHub App installation URL from the API and redirects.
 *
 * Flow: repository OAuth callback → this page → verified installation selection.
 */
export default function OAuthCallbackInstall() {
  const { t } = useI18n();
  const copy = t.library.connect.installationPicker;
  const [message, setMessage] = useState("Setting up GitHub access…");
  const [selection, setSelection] = useState<GitHubInstallationSelection | null>(null);
  const [outcome, setOutcome] = useState<"complete" | "error" | null>(null);
  const redirectStarted = useRef(false);
  const complete = () => {
    setSelection(null);
    setOutcome("complete");
    setMessage(copy.successDescription);
    closeAuthWindowAfterSuccess(300);
  };

  useEffect(() => {
    // React's development Strict Mode replays effects. Starting this transition
    // twice can mint competing installation states, so keep it one-shot.
    if (redirectStarted.current) return;
    redirectStarted.current = true;

    const params = new URLSearchParams(window.location.search);
    const state = params.get("state") ?? undefined;
    const linkError = params.get("error");
    if (linkError) {
      storeGitHubConnectError(linkError, undefined, state);
      setMessage(linkError);
      setOutcome("error");
      closeAuthWindowAfterSuccess(1800);
      return;
    }

    async function redirect() {
      try {
        // Use the shared API client so self-hosted callback pages honor the
        // same-origin `/api/proxy/api` mount instead of calling localhost:4000
        // in the operator's browser.
        const data = await githubApi.connect("oauth", state);
        if (data?.flow === "installations") {
          setSelection(data);
          return;
        }
        if (data?.flow === "redirect") {
          window.location.href = resolveApiNavigationUrl(
            typeof data.url === "string" ? data.url : endpoints.github.connectRedirect,
          );
          return;
        }
        if (!data?.connected) {
          throw new Error("GitHub did not return an installation destination.");
        }
        complete();
      } catch (error) {
        const detail = getApiErrorMessage(error, "Could not continue GitHub setup.");
        storeGitHubConnectError(detail, undefined, state);
        setOutcome("error");
        setMessage(detail);
        closeAuthWindowAfterSuccess(1800);
      }
    }

    void redirect();
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5 text-foreground">
      {selection ? <div className="w-full max-w-md rounded-2xl bg-card p-6">
        <GitHubInstallationPicker selection={selection}
          onComplete={complete}
          onInstall={() => { window.location.href = selection.installUrl; }}
          onRestart={() => { window.location.href = "/library"; }} />
      </div> : <div className="w-full max-w-md space-y-4 rounded-2xl bg-card p-6" role={outcome === "error" ? "alert" : "status"}>
        {outcome && <h1 className="text-xl font-semibold">{outcome === "complete" ? copy.successTitle : copy.errorTitle}</h1>}
        <p className="text-sm text-muted-foreground">{message}</p>
        {outcome && <Link href="/library" className="inline-block text-sm font-medium text-primary hover:underline">{copy.returnToApp}</Link>}
      </div>}
    </div>
  );
}
