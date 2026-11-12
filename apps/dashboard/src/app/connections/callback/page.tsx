"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { credentialsApi } from "@/lib/api/credentials";
import { getApiErrorMessage } from "@/lib/api/client";
import { Icon } from "@repo/ui/icons";

/** The authenticated API owns state/session/workspace checks. Never follow a
 * provider-supplied `next` URL or store authorization codes in browser storage. */
export default function ConnectionCallback() {
  const started = useRef(false);
  const [status, setStatus] = useState("Completing connection…");
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const state = params.get("state"),
      code = params.get("code");
    window.history.replaceState(null, "", window.location.pathname);
    const complete = async () => {
      let error: string | undefined;
      try {
        if (!state || !code || params.has("error"))
          throw new Error(
            "Authorization was cancelled or incomplete. Connect again from OpenShip.",
          );
        await credentialsApi.completeAuthorization({ state, code });
        setStatus("Connected. You can return to OpenShip.");
      } catch (failure) {
        error = getApiErrorMessage(
          failure,
          "The connection could not be completed. Try again from OpenShip.",
        );
        setStatus(error);
      }
      setDone(true);
      window.opener?.postMessage(
        { type: "openship:connection", state, error },
        window.location.origin,
      );
    };
    void complete();
  }, []);
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-md space-y-4 rounded-2xl bg-card p-6">
        {!done && <Icon name="spinner" className="size-5 animate-spin" />}
        <p role="status">{status}</p>
        {done && (
          <Link className="text-sm underline underline-offset-4" href="/settings?tab=connections">
            Open Connections
          </Link>
        )}
      </div>
    </main>
  );
}
