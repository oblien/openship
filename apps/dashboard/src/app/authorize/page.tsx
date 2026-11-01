"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { Suspense, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { buildAuthPageHref, getCloudDesktopHandoffUrl } from "@/lib/cloud-auth";
import { CloudAuthorizationIdentity } from "@/components/cloud/CloudAuthorizationIdentity";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * OAuth-style authorize page - shown after login (or immediately if
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
        <div className="flex items-center justify-center py-8"><UiIcon name="spinner" className="size-6 animate-spin text-muted-foreground" /></div>
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
  const { t } = useI18n();

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
          <h1 className="text-xl font-semibold">{t.misc.authorize.invalidRequest}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.misc.authorize.missingParams}
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
          <UiIcon name="spinner" className="size-6 animate-spin text-muted-foreground" />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell maxWidth="max-w-[460px]">
      <div className="mb-7">
        <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-card">
          <UiIcon name="monitor" className="size-6 text-foreground" />
        </div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">
          {interpolate(t.misc.authorize.title, { app: appName })}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {machine
            ? interpolate(t.misc.authorize.wantsToConnectOnMachine, { app: appName, machine })
            : interpolate(t.misc.authorize.wantsToConnect, { app: appName })}
        </p>
      </div>

      <CloudAuthorizationIdentity session={session} disabled={false} loginUrl={loginUrl}>
        {(ready) => (
          <>
            <div className="mb-5 space-y-2 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">{t.misc.authorize.willAllow}</p>
              <p className="flex items-center gap-2">
                <UiIcon name="check" className="size-4 shrink-0" aria-hidden="true" />
                {t.misc.authorize.permDeploy}
              </p>
              <p className="flex items-center gap-2">
                <UiIcon name="check" className="size-4 shrink-0" aria-hidden="true" />
                {t.misc.authorize.permAccess}
              </p>
            </div>

            <div className="space-y-2">
              <Button
                className="w-full"
                size="lg"
                disabled={!ready || !handoffUrl}
                onClick={() => {
                  if (handoffUrl) window.location.href = handoffUrl;
                }}
              >
                {t.misc.authorize.authorize}
              </Button>
              <Button variant="outline" className="w-full" onClick={() => window.close()}>
                {t.misc.authorize.cancel}
              </Button>
            </div>
          </>
        )}
      </CloudAuthorizationIdentity>
    </AuthShell>
  );
}
