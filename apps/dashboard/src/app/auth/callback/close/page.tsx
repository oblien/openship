"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { storeGitHubConnectError, githubConnectErrorMessage } from "@/lib/github-connect-error";
import { useI18n } from "@/components/i18n-provider";
import { Icon } from "@repo/ui/icons";

/**
 * OAuth callback landing page - auto-closes the popup/window.
 *
 * Better Auth redirects here after a successful GitHub OAuth close-flow, and
 * also on a link FAILURE (errorCallbackURL points here with ?error=<code>).
 * The popup closes, and the opener detects it via the authWindow middleware.
 */
export default function OAuthCallbackClose() {
  const { t } = useI18n();
  const copy = t.library.connect.installationPicker;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // On a failed link, hand the error code to the opener (same-origin
    // localStorage) so it can toast instead of silently reporting "not
    // connected". Close immediately in that case — no cookies to settle.
    const params = new URLSearchParams(window.location.search);
    const linkError = params.get("error");
    if (linkError) {
      storeGitHubConnectError(linkError, undefined, params.get("state") ?? undefined);
      setError(githubConnectErrorMessage(linkError));
    }
    // Give a brief moment for cookies to settle on success, then close.
    const timer = setTimeout(() => window.close(), linkError ? 1800 : 600);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5 text-foreground">
      <div className="w-full max-w-md space-y-4 rounded-2xl bg-card p-6" role={error ? "alert" : "status"}>
        <Icon name="github" className="size-8 text-muted-foreground" />
        <h1 className="text-xl font-semibold">{error ? copy.errorTitle : copy.successTitle}</h1>
        <p className="text-sm text-muted-foreground">{error || copy.successDescription}</p>
        <Link href="/library" className="inline-block text-sm font-medium text-primary hover:underline">{copy.returnToApp}</Link>
      </div>
    </div>
  );
}
