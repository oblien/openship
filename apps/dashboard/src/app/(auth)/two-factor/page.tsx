"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { twoFactor } from "@/lib/auth-client";
import { buildAuthPageHref, getPostAuthRedirect } from "@/lib/cloud-auth";
import { twoFactorNext } from "./two-factor-next";

type FactorMethod = "totp" | "backup";

export default function TwoFactorPage() {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <AuthShell>
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            {t.auth.twoFactor.loading}
          </div>
        </AuthShell>
      }
    >
      <TwoFactorPageInner />
    </Suspense>
  );
}

function TwoFactorPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const copy = t.auth.twoFactor;
  const postLoginUrl = getPostAuthRedirect(searchParams);
  const loginHref = buildAuthPageHref("/login", searchParams);

  const [method, setMethod] = useState<FactorMethod>("totp");
  const [code, setCode] = useState("");
  const [rememberBrowser, setRememberBrowser] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const canSubmit = method === "totp"
    ? /^\d{6}$/.test(code)
    : /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(code.trim());

  function switchMethod() {
    setMethod((current) => (current === "totp" ? "backup" : "totp"));
    setCode("");
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setError(null);
    try {
      const result = method === "totp"
        ? await twoFactor.verifyTotp({ code, trustDevice: rememberBrowser })
        : await twoFactor.verifyBackupCode({
            code: code.trim(),
            trustDevice: rememberBrowser,
            disableSession: false,
          });
      const next = twoFactorNext(result, postLoginUrl);

      if (next.kind === "expired") {
        setExpired(true);
        setLoading(false);
        setCode("");
        return;
      }
      if (next.kind === "error") {
        if (next.code === "INVALID_CODE") setError(copy.invalidTotp);
        else if (next.code === "INVALID_BACKUP_CODE") setError(copy.invalidBackup);
        else setError(next.message || t.auth.errors.generic);
        setLoading(false);
        setCode("");
        return;
      }

      if (next.href !== "/") window.location.href = next.href;
      else router.push("/");
    } catch {
      setError(t.auth.errors.generic);
      setLoading(false);
      setCode("");
    }
  }

  if (expired) {
    return (
      <AuthShell>
        <div className="space-y-6 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
            <KeyRound className="size-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">{copy.expiredTitle}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{copy.expiredBody}</p>
          </div>
          <Button asChild className="w-full">
            <Link href={loginHref}>{copy.signInAgain}</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ShieldCheck className="size-6" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">{copy.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{copy.instructions}</p>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="two-factor-login-code">
              {method === "totp" ? copy.totpLabel : copy.backupLabel}
            </Label>
            <Input
              id="two-factor-login-code"
              inputMode={method === "totp" ? "numeric" : "text"}
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => {
                const next = method === "totp"
                  ? event.target.value.replace(/\D/g, "").slice(0, 6)
                  : event.target.value;
                setCode(next);
              }}
              placeholder={method === "totp" ? copy.totpPlaceholder : copy.backupPlaceholder}
              autoFocus
            />
          </div>

          <button
            type="button"
            onClick={switchMethod}
            disabled={loading}
            className="text-sm font-medium text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
          >
            {method === "totp" ? copy.useBackup : copy.useAuthenticator}
          </button>

          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5 size-4 rounded border-input"
              checked={rememberBrowser}
              onChange={(event) => setRememberBrowser(event.target.checked)}
              disabled={loading}
            />
            <span>{copy.rememberBrowser}</span>
          </label>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading || !canSubmit}>
            {loading && <Loader2 className="animate-spin" />}
            {loading ? copy.submitting : copy.submit}
          </Button>
        </form>

        <div className="text-center">
          <Link
            href={loginHref}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {copy.backToLogin}
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}
