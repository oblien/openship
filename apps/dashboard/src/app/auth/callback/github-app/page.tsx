"use client";

import { useEffect, useRef, useState } from "react";
import { getApiErrorMessage, githubApi } from "@/lib/api";
import { storeGitHubConnectError } from "@/lib/github-connect-error";
import { closeAuthWindowAfterSuccess } from "@/utils/authWindow";

/** GitHub App Setup URL landing page for an operator-owned self-hosted App. */
export default function GitHubAppSetupCallback() {
  const [message, setMessage] = useState("Verifying the GitHub App installation…");
  const claimStarted = useRef(false);

  useEffect(() => {
    // React's development Strict Mode replays effects. The installation nonce
    // is intentionally one-shot, so never submit the same claim twice.
    if (claimStarted.current) return;
    claimStarted.current = true;

    const fail = (detail: string) => {
      storeGitHubConnectError(detail);
      setMessage(detail);
      // Leave enough time to read the local explanation; the opener also
      // receives it from localStorage and shows the durable toast.
      closeAuthWindowAfterSuccess(2200);
    };

    async function claim() {
      const query = new URLSearchParams(window.location.search);
      const flow = query.get("flow");
      const code = query.get("code");
      const installationId = query.get("installation_id");
      const state = query.get("state");
      const setupAction = query.get("setup_action");

      if (!state || (flow === "manifest" ? !code : !installationId)) {
        fail("GitHub did not return the required installation details. Start again from Settings.");
        return;
      }

      try {
        if (flow === "manifest") {
          const data = await githubApi.convertSourceManifest(state, code!);
          if (!data?.installUrl)
            throw new Error("GitHub App was created, but its install URL is missing.");
          setMessage("GitHub App created. Opening repository access…");
          window.location.replace(data.installUrl);
          return;
        }

        const data = await githubApi.claimInstallation({
          state,
          installationId: installationId!,
          setupAction: setupAction ?? undefined,
        });
        if (data?.pendingApproval) {
          setMessage("Installation requested. A GitHub organization owner must approve it.");
          closeAuthWindowAfterSuccess(2200);
          return;
        }
        setMessage(
          `${data?.installation?.login || "GitHub"} is connected. You can close this window.`,
        );
        closeAuthWindowAfterSuccess(1200);
      } catch (error) {
        const detail = getApiErrorMessage(error, "Could not verify the installation.");
        fail(detail);
      }
    }
    void claim();
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-background px-6 text-foreground">
      <p className="max-w-md text-center text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
