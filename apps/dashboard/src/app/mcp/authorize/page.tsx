"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { useI18n } from "@/components/i18n-provider";
import { Icon as UiIcon } from "@repo/ui/icons";
import { AuthShell } from "@/components/auth-shell";
import { McpAuthorizationForm } from "@/components/permissions/McpAuthorizationForm";

const RETRY_PARAM = "signedIn";

function buildLoginHref(searchParams: URLSearchParams): string {
  const back = new URLSearchParams(searchParams.toString());
  back.set(RETRY_PARAM, "1");
  const qs = back.toString();
  return `/login?returnTo=${encodeURIComponent(`/mcp/authorize?${qs}`)}`;
}

function McpAuthorizeInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const unauthorized = useCallback(
    () => router.replace(buildLoginHref(new URLSearchParams(searchParams.toString()))),
    [router, searchParams],
  );
  const complete = useCallback(
    (redirectURI: string | null) => {
      if (redirectURI) window.location.href = redirectURI;
      else router.replace("/");
    },
    [router],
  );
  if (!hydrated || isPending)
    return (
      <div className="flex justify-center py-10">
        <UiIcon name="spinner" className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  if (!session) return <SignInPrompt alreadyTried={searchParams.get(RETRY_PARAM) === "1"} />;
  return (
    <McpAuthorizationForm
      key={searchParams.get("consent_code")}
      clientId={searchParams.get("client_id")}
      consentCode={searchParams.get("consent_code")}
      onComplete={complete}
      onUnauthorized={unauthorized}
    />
  );
}

/**
 * Signed-out state. On first arrival it redirects itself to /login once (in an
 * effect, so it can't re-fire per render); if we're already back from /login and
 * still have no client session, it stops and shows the link instead — the only
 * way to guarantee this can't become a redirect loop.
 */
function SignInPrompt({ alreadyTried }: { alreadyTried: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const m = t.misc.mcpAuthorize;
  const href = buildLoginHref(new URLSearchParams(searchParams.toString()));

  useEffect(() => {
    if (alreadyTried) return;
    router.replace(href);
  }, [alreadyTried, href, router]);

  if (!alreadyTried) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <UiIcon name="spinner" className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md text-center">
      <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-2xl bg-warning-bg text-warning">
        <UiIcon name="alert-circle" className="size-5" />
      </div>
      <h1 className="text-lg font-semibold text-foreground">{m.signInRequiredTitle}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{m.signInRequiredBody}</p>
      <a
        href={href}
        className="mt-4 inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {m.signInAction}
      </a>
    </div>
  );
}

export default function McpAuthorizePage() {
  return (
    // `align="start"`: this page is taller than the viewport, and AuthShell's
    // default vertical centering would push its top above the scroll origin and
    // break the sticky rail.
    <AuthShell maxWidth="max-w-6xl" align="start">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <UiIcon name="spinner" className="size-5 animate-spin" />
          </div>
        }
      >
        <McpAuthorizeInner />
      </Suspense>
    </AuthShell>
  );
}
