"use client";

import { useEffect } from "react";
import { GITHUB_CONNECT_ERROR_KEY } from "@/lib/github-connect-error";
import { GITLAB_CONNECT_ERROR_KEY } from "@/lib/gitlab-connect-error";

/**
 * OAuth callback landing page - auto-closes the popup/window.
 *
 * Better Auth redirects here after a successful GitHub/GitLab OAuth
 * close-flow, and also on a link FAILURE (errorCallbackURL points here with
 * ?error=<code>). The popup closes, and the opener detects it via the
 * authWindow middleware.
 */
export default function OAuthCallbackClose() {
  useEffect(() => {
    // On a failed link, hand the error code to the opener (same-origin
    // localStorage) so it can toast instead of silently reporting "not
    // connected". Close immediately in that case — no cookies to settle.
    // `provider` distinguishes which connect flow this popup came from
    // (defaults to github, the original/only caller of this page) so the
    // error lands in the right key for the opener to read.
    const params = new URLSearchParams(window.location.search);
    const linkError = params.get("error");
    const provider = params.get("provider") === "gitlab" ? "gitlab" : "github";
    if (linkError) {
      const key = provider === "gitlab" ? GITLAB_CONNECT_ERROR_KEY : GITHUB_CONNECT_ERROR_KEY;
      try { localStorage.setItem(key, linkError); } catch { /* storage unavailable */ }
    }
    // Give a brief moment for cookies to settle on success, then close.
    const timer = setTimeout(() => window.close(), linkError ? 0 : 300);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <p className="text-sm text-muted-foreground">Authenticated - closing…</p>
    </div>
  );
}
