"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { buildAuthPageHref, getCloudDesktopHandoffUrl } from "@/lib/cloud-auth";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Loader2, Monitor, Check } from "lucide-react";

/**
 * OAuth-style authorize page — shown after login (or immediately if
 * already logged in) when a desktop app requests access.
 *
 * Flow:
 *   - Desktop opens /authorize?callback=...&app=...&machine=...
 *   - If not logged in → redirect to /login (preserving params)
 *   - If logged in → show authorize UI with explicit button
 *   - Authorize → handoff endpoint → redirect back to desktop API
 */
export default function AuthorizePage() {
  return (
    <Suspense fallback={
      <AuthShell>
        <div className="flex items-center justify-center py-8"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      </AuthShell>
    }>
      <AuthorizePageInner />
    </Suspense>
  );
}

function AuthorizePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const callback = searchParams.get("callback");
  const appName = searchParams.get("app") || "Openship Desktop";
  const machine = searchParams.get("machine");
  const state = searchParams.get("state");
  const codeChallenge = searchParams.get("code_challenge");

  // Build handoff URL with state + PKCE challenge
  const handoffUrl = callback
    ? getCloudDesktopHandoffUrl({
        callbackUrl: callback,
        state,
        codeChallenge,
      })
    : null;

  // Preserve the desktop-cloud flow marker so login/register/OAuth
  // return to /authorize instead of falling back to the normal app flow.
  const loginUrl = buildAuthPageHref("/login", searchParams);

  // Not logged in → redirect to login
  useEffect(() => {
    if (!isPending && !session) {
      router.replace(loginUrl);
    }
  }, [isPending, session, loginUrl, router]);

  // No callback → invalid request
  if (!callback) {
    return (
      <AuthShell>
        <div className="text-center">
          <h1 className="text-xl font-semibold">Invalid Request</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Missing authorization parameters.
          </p>
        </div>
      </AuthShell>
    );
  }

  // Loading or not authenticated yet
  if (isPending || !session) {
    return (
      <AuthShell>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="mb-6 text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/80 to-primary shadow-sm">
          <Monitor className="size-7 text-primary-foreground" />
        </div>
        <h1 className="text-xl font-semibold">Authorize {appName}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {appName}
          {machine ? ` on ${machine}` : ""} wants to connect to your account.
        </p>
      </div>

      <div className="mb-6 rounded-lg border border-border bg-muted/30 p-4">
        <p className="text-sm font-medium text-foreground">Signed in as</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{session.user.email}</p>

        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-foreground">This will allow:</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li className="flex items-center gap-2">
              <Check className="size-3.5 text-green-500 shrink-0" />
              Deploy and manage applications
            </li>
            <li className="flex items-center gap-2">
              <Check className="size-3.5 text-green-500 shrink-0" />
              Access your projects and settings
            </li>
          </ul>
        </div>
      </div>

      <div className="space-y-2">
        <Button
          className="w-full"
          size="lg"
          onClick={() => {
            if (handoffUrl) window.location.href = handoffUrl;
          }}
        >
          Authorize
        </Button>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => window.close()}
        >
          Cancel
        </Button>
      </div>
    </AuthShell>
  );
}
