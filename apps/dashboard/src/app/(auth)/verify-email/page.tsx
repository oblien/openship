"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { emailOtp, verifyEmail } from "@/lib/auth-client";
import { useToast } from "@/components/toast";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import OTPInput from "@/components/shared/OTPInput";
import { CheckCircle2, Loader2, Mail, XCircle } from "lucide-react";
import { isNetworkError } from "@/lib/api";

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={
      <AuthShell>
        <div className="flex justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      </AuthShell>
    }>
      <VerifyEmailContent />
    </Suspense>
  );
}

function VerifyEmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const emailParam = searchParams.get("email") ?? "";
  const { toast } = useToast();
  const { t } = useI18n();

  const [status, setStatus] = useState<"pending" | "verifying" | "verified" | "error">(
    token ? "verifying" : "pending",
  );
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Legacy magic-link path: if a ?token= is present (an older link), verify it.
  // New signups receive a CODE (no link) — handled by the form below.
  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    async function verify() {
      try {
        const result = await verifyEmail({ query: { token: token! } });
        if (cancelled) return;
        if (result.error) {
          setStatus("error");
          setErrorMessage(result.error.message ?? t.auth.errors.verificationFailed);
        } else {
          setStatus("verified");
        }
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(
          isNetworkError(err)
            ? t.auth.errors.serverUnreachable
            : t.auth.errors.verificationExpired,
        );
      }
    }

    verify();
    return () => { cancelled = true; };
  }, [token, t]);

  // Map the emailOTP plugin's error codes to a clear, actionable message.
  // TOO_MANY_ATTEMPTS = the code is now locked (invalidated) → they must resend.
  function codeErrorMessage(codeErr?: string | null, fallback?: string): string {
    switch (codeErr) {
      case "TOO_MANY_ATTEMPTS":
        return t.auth.verifyEmail.codeLocked;
      case "OTP_EXPIRED":
        return t.auth.verifyEmail.codeExpired;
      case "INVALID_OTP":
        return t.auth.verifyEmail.codeInvalid;
      default:
        return fallback ?? t.auth.errors.verificationFailed;
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    const otp = code.trim();
    if (!emailParam || otp.length < 6) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await emailOtp.verifyEmail({ email: emailParam, otp });
      if (result.error) {
        setErrorMessage(codeErrorMessage(result.error.code, result.error.message));
        // Once the code is locked/expired, it's useless — clear it so they resend.
        if (result.error.code === "TOO_MANY_ATTEMPTS" || result.error.code === "OTP_EXPIRED") {
          setCode("");
        }
      } else {
        setStatus("verified");
      }
    } catch (err) {
      setErrorMessage(
        isNetworkError(err) ? t.auth.errors.serverUnreachable : t.auth.errors.verificationFailed,
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (!emailParam) return;
    setResending(true);
    try {
      const result = await emailOtp.sendVerificationOtp({
        email: emailParam,
        type: "email-verification",
      });
      if (result?.error) {
        // Requests are throttled (rateLimit) — ask them to wait rather than
        // showing a generic failure.
        const rateLimited =
          result.error.code === "RATE_LIMIT" ||
          /rate|too many|limit|429/i.test(result.error.message ?? "");
        toast(
          "error",
          rateLimited ? t.auth.verifyEmail.resendRateLimited : t.auth.errors.resendFailed,
        );
      } else {
        toast("success", t.auth.errors.verificationSent);
      }
    } catch (err) {
      const msg = isNetworkError(err)
        ? t.auth.errors.serverUnreachable
        : t.auth.errors.resendFailed;
      toast("error", msg);
    } finally {
      setResending(false);
    }
  }

  if (status === "verifying") {
    return (
      <AuthShell>
        <div className="flex flex-col items-center text-center">
          <Loader2 className="mb-4 size-8 animate-spin text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {t.auth.verifyEmail.verifyingTitle}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.auth.verifyEmail.verifyingSubtitle}
          </p>
        </div>
      </AuthShell>
    );
  }

  if (status === "verified") {
    return (
      <AuthShell>
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-success-bg">
            <CheckCircle2 className="size-6 text-success" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {t.auth.verifyEmail.verifiedTitle}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.auth.verifyEmail.verifiedDescription}
          </p>
          <Button className="mt-6" onClick={() => router.push("/login")}>
            {t.auth.verifyEmail.verifiedAction}
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (status === "error") {
    return (
      <AuthShell>
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-destructive/10">
            <XCircle className="size-6 text-destructive" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {t.auth.verifyEmail.errorTitle}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {errorMessage ?? t.auth.verifyEmail.errorDescription}
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            {emailParam && (
              <Button variant="outline" onClick={handleResend} disabled={resending}>
                {resending && <Loader2 className="animate-spin" />}
                {t.auth.verifyEmail.resendEmail}
              </Button>
            )}
            <Button asChild>
              <Link href="/login">{t.auth.verifyEmail.signIn}</Link>
            </Button>
          </div>
        </div>
      </AuthShell>
    );
  }

  // pending → enter the verification CODE we emailed (no magic link)
  return (
    <AuthShell>
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-secondary">
          <Mail className="size-6 text-foreground" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t.auth.verifyEmail.pendingTitle}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {emailParam
            ? interpolate(t.auth.verifyEmail.pendingSentTo, { email: emailParam })
            : t.auth.verifyEmail.pendingGeneric}
        </p>

        <form onSubmit={handleVerifyCode} className="mt-6 space-y-4">
          <div className="space-y-2">
            <Label className="block text-center">{t.auth.verifyEmail.codeLabel}</Label>
            <OTPInput
              length={6}
              value={code}
              onChange={setCode}
              disabled={submitting}
              autoFocus
            />
          </div>
          {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
          <Button type="submit" className="w-full" disabled={submitting || code.trim().length < 6}>
            {submitting && <Loader2 className="animate-spin" />}
            {t.auth.verifyEmail.verifyCode}
          </Button>
        </form>

        {emailParam && (
          <Button
            variant="outline"
            className="mt-3"
            onClick={handleResend}
            disabled={resending}
          >
            {resending && <Loader2 className="animate-spin" />}
            {t.auth.verifyEmail.resendVerification}
          </Button>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          {t.auth.verifyEmail.spamHint}
        </p>

        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/login" className="font-medium text-foreground transition-colors hover:underline">
            {t.auth.verifyEmail.backToSignIn}
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
