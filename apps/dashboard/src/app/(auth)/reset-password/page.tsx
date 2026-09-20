"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { emailOtp, resetPassword } from "@/lib/auth-client";
import { useToast } from "@/components/toast";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import { isNetworkError } from "@/lib/api";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <AuthShell>
        <div className="flex justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      </AuthShell>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  // `token` is the RETIRED link flow, kept only so a reset email already sitting in
  // someone's inbox still works. New requests arrive with `email` and no token, and
  // the user types the 6-digit code — see lib/auth-client emailOtp.resetPassword for
  // why the link went away.
  const token = searchParams.get("token") ?? "";
  const { toast } = useToast();
  const { t } = useI18n();

  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // Same mapping verify-email uses, so a wrong/expired/locked code reads the same in
  // both flows. TOO_MANY_ATTEMPTS means the code was invalidated — they must request
  // a fresh one rather than keep guessing.
  function codeErrorMessage(codeErr?: string | null, fallback?: string): string {
    switch (codeErr) {
      case "TOO_MANY_ATTEMPTS":
        return t.auth.verifyEmail.codeLocked;
      case "OTP_EXPIRED":
        return t.auth.verifyEmail.codeExpired;
      case "INVALID_OTP":
        return t.auth.verifyEmail.codeInvalid;
      default:
        return fallback ?? t.auth.errors.resetFailed;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (password.length < 8) {
      toast("error", t.auth.errors.passwordMin);
      return;
    }
    if (password !== confirm) {
      toast("error", t.auth.errors.passwordMismatch);
      return;
    }
    // Legacy link: a token in the URL is proof on its own, so no code is asked for.
    if (!token && (!email.trim() || code.trim().length < 6)) {
      toast("error", t.auth.verifyEmail.codeInvalid);
      return;
    }

    setLoading(true);
    try {
      const result = token
        ? await resetPassword({ newPassword: password, token })
        : await emailOtp.resetPassword({
            email: email.trim(),
            otp: code.trim(),
            password,
          });
      if (result?.error) {
        toast(
          "error",
          token
            ? (result.error.message ?? t.auth.errors.resetFailed)
            : codeErrorMessage(
                (result.error as { code?: string }).code,
                result.error.message,
              ),
        );
      } else {
        setDone(true);
      }
    } catch (err) {
      toast("error", isNetworkError(err)
        ? t.auth.errors.serverUnreachable
        : t.auth.errors.generic);
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <AuthShell>
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-success-bg">
            <CheckCircle2 className="size-6 text-success" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {t.auth.resetPassword.doneTitle}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.auth.resetPassword.doneDescription}
          </p>
          <Button asChild className="mt-6">
            <Link href="/login">{t.auth.resetPassword.doneAction}</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t.auth.resetPassword.title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {token
            ? t.auth.resetPassword.subtitle
            : email
              ? interpolate(t.auth.resetPassword.codeSentTo, { email })
              : t.auth.resetPassword.codeSentGeneric}
        </p>
        {!token && (
          <p className="mt-2 text-xs text-muted-foreground/70">
            {t.auth.forgotPassword.spamHint}
          </p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {!token && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="reset-email">{t.auth.forgotPassword.emailLabel}</Label>
              <Input
                id="reset-email"
                type="email"
                autoComplete="email"
                placeholder={t.auth.forgotPassword.emailPlaceholder}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reset-code">{t.auth.verifyEmail.codeLabel}</Label>
              <Input
                id="reset-code"
                // `one-time-code` lets iOS/Android offer the code straight from the
                // notification, which is most of why a code beats a link on a phone.
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                placeholder={t.auth.verifyEmail.codePlaceholder}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
                className="text-center tracking-[0.4em] font-mono"
              />
            </div>
          </>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="reset-password">{t.auth.resetPassword.passwordLabel}</Label>
          <div className="relative">
            <Input
              id="reset-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder={t.auth.resetPassword.passwordPlaceholder}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="pe-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              tabIndex={-1}
              className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={showPassword ? t.auth.hidePassword : t.auth.showPassword}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="reset-confirm">{t.auth.resetPassword.confirmLabel}</Label>
          <Input
            id="reset-confirm"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            placeholder={t.auth.resetPassword.confirmPlaceholder}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
          />
        </div>

        <Button type="submit" disabled={loading} className="mt-1 w-full">
          {loading && <Loader2 className="animate-spin" />}
          {loading ? t.auth.resetPassword.submitting : t.auth.resetPassword.submit}
        </Button>
      </form>

      <p className="mt-8 text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-foreground transition-colors hover:underline">
          {t.auth.resetPassword.backToSignIn}
        </Link>
      </p>
    </AuthShell>
  );
}
