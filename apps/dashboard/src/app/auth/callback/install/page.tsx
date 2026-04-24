"use client";

import { useEffect } from "react";
import { getApiOrigin } from "@/lib/api/urls";

/**
 * OAuth callback for cloud mode — after GitHub OAuth completes,
 * fetches the GitHub App installation URL from the API and redirects.
 *
 * Flow: GitHub OAuth → Better Auth callback → this page → GitHub App install
 */
export default function OAuthCallbackInstall() {
  useEffect(() => {
    async function redirect() {
      try {
        const BASE = getApiOrigin();
        const res = await fetch(`${BASE}/api/github/connect`, {
          method: "POST",
          credentials: "include",
        });
        const data = await res.json();

        if (data?.url) {
          window.location.href = data.url;
          return;
        }
      } catch {
        // If fetch fails, just close — the opener will detect it
      }
      window.close();
    }

    redirect();
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <p className="text-sm text-muted-foreground">Setting up GitHub access…</p>
    </div>
  );
}
