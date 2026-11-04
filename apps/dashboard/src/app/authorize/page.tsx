"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { buildAuthPageHref } from "@/lib/cloud-auth";
import { cloudApi } from "@/lib/api";
import { ApiError, getApiErrorMessage } from "@/lib/api/client";
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
 *   - Authorize → authenticated consent POST → redirect back to desktop API
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
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const authorizationInFlight = useRef(false);

  // Preserve the desktop-cloud flow marker so login/register/OAuth
  // return to /authorize instead of falling back to the normal app flow.
  const loginUrl = buildAuthPageHref("/login", searchParams);

  const handleAuthorize = async () => {
    if (!callback || !state || !codeChallenge || authorizationInFlight.current) return;
    authorizationInFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await cloudApi.connectAuthorize({
        redirect: callback,
        state,
        codeChallenge,
        mode: "desktop",
      });
      if (!result.callbackUrl) throw new Error(t.misc.cloudAuthorize.authorizeError);
      window.location.href = result.callbackUrl;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) router.replace(loginUrl);
      else setSubmitError(getApiErrorMessage(error, t.misc.cloudAuthorize.authorizeError));
      authorizationInFlight.current = false;
      setSubmitting(false);
    }
  };

  // Not logged in → redirect to login
  useEffect(() => {
    if (!isPending && !session) {
      router.replace(loginUrl);
    }
  }, [isPending, session, loginUrl, router]);

  // No callback → invalid request
  if (!callback || !state || !codeChallenge) {
    return (
      <AuthShell>
        <div className="text-center">
          <h1 className="text-xl font-semibold">{t.misc.authorize.invalidRequest}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t.misc.authorize.missingParams}</p>
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

      <CloudAuthorizationIdentity session={session} disabled={submitting} loginUrl={loginUrl}>
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
              {submitError && (
                <p role="alert" className="text-sm text-danger">
                  {submitError}
                </p>
              )}
              <Button
                className="w-full"
                size="lg"
                disabled={!ready || submitting}
                onClick={() => {
                  void handleAuthorize();
                }}
              >
                {submitting ? t.misc.cloudAuthorize.authorizing : t.misc.authorize.authorize}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                disabled={submitting}
                onClick={() => window.close()}
              >
                {t.misc.authorize.cancel}
              </Button>
            </div>
          </>
        )}
      </CloudAuthorizationIdentity>
    </AuthShell>
  );
}
