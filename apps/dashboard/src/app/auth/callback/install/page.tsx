"use client";

import { useEffect, useRef, useState } from "react";
import { githubApi, endpoints, getApiErrorMessage } from "@/lib/api";
import { resolveApiNavigationUrl } from "@/lib/api/urls";
import { storeGitHubConnectError } from "@/lib/github-connect-error";
import { closeAuthWindowAfterSuccess } from "@/utils/authWindow";

/**
 * OAuth callback for cloud mode - after GitHub OAuth completes,
 * fetches the GitHub App installation URL from the API and redirects.
 *
 * Flow: GitHub OAuth → Better Auth callback → this page → GitHub App install
 */
export default function OAuthCallbackInstall() {
  const [message, setMessage] = useState("Setting up GitHub access…");
  const redirectStarted = useRef(false);

  useEffect(() => {
    // React's development Strict Mode replays effects. Starting this transition
    // twice can mint competing installation states, so keep it one-shot.
    if (redirectStarted.current) return;
    redirectStarted.current = true;

    // Better Auth appends ?error=<code> on a failed link (e.g. the GitHub
    // account is already linked to a different user). Hand it to the opener
    // via same-origin localStorage and close instead of proceeding to install.
    const linkError = new URLSearchParams(window.location.search).get("error");
    if (linkError) {
      storeGitHubConnectError(linkError);
      closeAuthWindowAfterSuccess(0);
      return;
    }

    async function redirect() {
      try {
        // Use the shared API client so self-hosted callback pages honor the
        // same-origin `/api/proxy/api` mount instead of calling localhost:4000
        // in the operator's browser.
        const data = await githubApi.connect();
        if (data?.flow === "redirect") {
          window.location.href = resolveApiNavigationUrl(
            typeof data.url === "string" ? data.url : endpoints.github.connectRedirect,
          );
          return;
        }
        if (!data?.connected) {
          throw new Error("GitHub did not return an installation destination.");
        }
        closeAuthWindowAfterSuccess(300);
      } catch (error) {
        const detail = getApiErrorMessage(error, "Could not continue GitHub setup.");
        storeGitHubConnectError(detail);
        setMessage(detail);
        closeAuthWindowAfterSuccess(1800);
      }
    }

    void redirect();
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
