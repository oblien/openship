"use client";

/**
 * /cloud-connect-callback — popup landing page for the cloud-connect flow.
 *
 * Why this lives on the dashboard origin (and not the API):
 *   The PKCE verifier is stashed in localStorage by CloudContext on the
 *   dashboard origin BEFORE the popup opens. localStorage is per-origin,
 *   so the callback MUST land back on the same origin to read it back.
 *   Landing on the API origin (which differs from the dashboard origin in
 *   the default split-port self-hosted layout) means the verifier is
 *   invisible — PKCE check fails on the SaaS exchange.
 *
 * What this page does:
 *   1. Reads `code` + `state` from the URL.
 *   2. Reads the PKCE verifier from
 *        localStorage[CONNECT_PKCE_STORAGE_PREFIX + state]
 *      and removes the entry (one-time use).
 *   3. POSTs `{ code, codeVerifier }` to the local API's
 *      /api/cloud/connect-finalize (cross-origin, credentials included —
 *      the API's CORS allowlist already contains the dashboard origin).
 *   4. On success: notifies opener via postMessage and closes the popup.
 *   5. On failure: shows the API's error message in-place.
 */

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Check, AlertCircle } from "lucide-react";
import { cloudApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { CONNECT_PKCE_STORAGE_PREFIX } from "@/lib/cloud-auth";
import { closeAuthWindowAfterSuccess } from "@/utils/authWindow";
import { AuthShell } from "@/components/auth-shell";
import { useI18n } from "@/components/i18n-provider";

type CallbackStatus = "loading" | "success" | "error";

function CloudConnectCallbackInner() {
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const m = t.misc.cloudConnect;
  const [status, setStatus] = useState<CallbackStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");

  useEffect(() => {
    if (searchParams.get("setup_error") === "pkce") {
      setStatus("error");
      setErrorMessage(
        "Openship could not securely start the Cloud sign-in. Close this window and try again.",
      );
      return;
    }

    const code = searchParams.get("code");
    const state = searchParams.get("state") ?? "";

    if (!code) {
      setStatus("error");
      setErrorMessage(m.noCode);
      return;
    }

    // Pull the PKCE verifier stashed by CloudContext.prepareConnectUrl
    // before the popup opened. Same-origin localStorage so this works
    // even when the dashboard and API live on different ports.
    let verifier: string | null = null;
    if (state) {
      try {
        verifier = window.localStorage.getItem(CONNECT_PKCE_STORAGE_PREFIX + state);
        // One-time use — remove regardless of finalize outcome so a
        // failed flow can't have its verifier replayed by a stale tab.
        window.localStorage.removeItem(CONNECT_PKCE_STORAGE_PREFIX + state);
      } catch {
        /* localStorage disabled — verifier stays null, fall back to non-PKCE */
      }
    }

    if (state && !verifier) {
      setStatus("error");
      setErrorMessage(m.stateExpired);
      return;
    }

    void cloudApi
      .connectFinalize({ code, codeVerifier: verifier ?? undefined })
      .then(() => {
        setStatus("success");
        // Tell the opener it can re-check status without waiting for the
        // window-close poll. Opener may be on a different origin (it isn't
        // here, but be conservative) so we use "*" target.
        try {
          if (window.opener) {
            window.opener.postMessage({ type: "cloud-connect-success" }, "*");
          }
        } catch {
          /* opener gone / cross-origin throws — ignore */
        }
        // Cloud login may clear window.opener via Cross-Origin-Opener-Policy.
        // The popup is still script-opened and should close after success.
        closeAuthWindowAfterSuccess();
      })
      .catch((err) => {
        setStatus("error");
        setErrorMessage(getApiErrorMessage(err, m.verifyError));
      });
  }, [searchParams, m]);

  if (status === "loading") {
    return (
      <AuthShell>
        <div className="flex flex-col items-center justify-center py-4 text-center">
          <Loader2 className="mb-4 size-8 animate-spin text-muted-foreground" />
          <h1 className="text-lg font-semibold">{m.finalizingTitle}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{m.finalizingSubtitle}</p>
        </div>
      </AuthShell>
    );
  }

  if (status === "success") {
    return (
      <AuthShell>
        <div className="flex flex-col items-center justify-center py-4 text-center">
          <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/80 to-emerald-600 shadow-sm">
            <Check className="size-7 text-white" />
          </div>
          <h1 className="text-lg font-semibold">{m.successTitle}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {m.successDescription}
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="flex flex-col items-center justify-center py-4 text-center">
        <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500/80 to-red-600 shadow-sm">
          <AlertCircle className="size-7 text-white" />
        </div>
        <h1 className="text-lg font-semibold">{m.failedTitle}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{errorMessage}</p>
      </div>
    </AuthShell>
  );
}

export default function CloudConnectCallbackPage() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        </AuthShell>
      }
    >
      <CloudConnectCallbackInner />
    </Suspense>
  );
}
