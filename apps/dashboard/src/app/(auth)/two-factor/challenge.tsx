"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { authClient } from "@/lib/auth-client";
import { accountSecurityRedirect } from "@/lib/account-security";
import { buildAuthPageHref, getPostAuthRedirect } from "@/lib/cloud-auth";
import { useI18n } from "@/components/i18n-provider";
import { AuthShell } from "@/components/auth-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useAuthContext } from "../providers";

export function TwoFactorChallenge() {
  const { t } = useI18n();
  const copy = t.auth.security;
  const params = useSearchParams();
  const { authMode } = useAuthContext();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const login = buildAuthPageHref("/login", params);

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setError("");
    try {
      const result = recovery
        ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
        : await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, "") });
      if (result.error) {
        const timedOut = result.error.code === "INVALID_TWO_FACTOR_COOKIE";
        setExpired(timedOut);
        setError(timedOut ? copy.expired : result.error.message || copy.invalidCode);
        setWorking(false);
        return;
      }
      // Full navigation sends the newly verified cookie to the auth/dashboard
      // layouts. OAuth destinations come from the API's signed continuation.
      window.location.assign(
        accountSecurityRedirect(result.data) || getPostAuthRedirect(params) || "/",
      );
    } catch {
      setError(t.auth.errors.serverUnreachable);
      setWorking(false);
    }
  }

  return (
    <AuthShell>
      <div className="text-center">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon name="shield-check" className="size-6" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{copy.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {recovery ? copy.recoveryHint : copy.challengeHint}
        </p>
      </div>
      {authMode !== "local" ? (
        <p className="mt-6 text-sm text-muted-foreground">{copy.unavailable}</p>
      ) : (
        <>
          {error && (
            <p role="alert" className="mt-5 rounded-xl bg-danger-bg p-3 text-sm text-danger">
              {error}
            </p>
          )}
          {!expired && (
            <form onSubmit={verify} className="mt-6 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="two-factor-code">{recovery ? copy.recoveryCode : copy.code}</Label>
                <Input
                  id="two-factor-code"
                  variant="filled"
                  className="bg-card"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode={recovery ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  maxLength={recovery ? 32 : 12}
                  dir="ltr"
                  disabled={working}
                />
              </div>
              <Button type="submit" disabled={working || !code.trim()} className="w-full">
                {working && <Icon name="spinner" className="size-4 animate-spin" />}
                {copy.verify}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={working}
                className="w-full"
                onClick={() => {
                  setRecovery(!recovery);
                  setCode("");
                  setError("");
                }}
              >
                {recovery ? copy.useAuthenticator : copy.useRecovery}
              </Button>
            </form>
          )}
        </>
      )}
      <Link
        href={login}
        className="mt-5 block text-center text-sm text-muted-foreground hover:text-foreground"
      >
        {copy.backToLogin}
      </Link>
    </AuthShell>
  );
}
