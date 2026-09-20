"use client";

import { useEffect } from "react";
import { storeGitHubConnectError } from "@/lib/github-connect-error";

/**
 * OAuth callback landing page - auto-closes the popup/window.
 *
 * Better Auth redirects here after a successful GitHub OAuth close-flow, and
 * also on a link FAILURE (errorCallbackURL points here with ?error=<code>).
 * The popup closes, and the opener detects it via the authWindow middleware.
 */
export default function OAuthCallbackClose() {
  useEffect(() => {
    // On a failed link, hand the error code to the opener (same-origin
    // localStorage) so it can toast instead of silently reporting "not
    // connected". Close immediately in that case — no cookies to settle.
    const linkError = new URLSearchParams(window.location.search).get("error");
    if (linkError) {
      storeGitHubConnectError(linkError);
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
