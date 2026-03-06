"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { sendVerificationEmail, verifyEmail } from "@/lib/auth-client";
import { useToast } from "@/components/toast";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, Mail, XCircle } from "lucide-react";

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

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
  const [resending, setResending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
          isAbortError(err)
            ? t.auth.errors.serverUnreachable
            : t.auth.errors.verificationExpired,
        );
      }
    }

    verify();
    return () => { cancelled = true; };
  }, [token, t]);

  async function handleResend() {
    if (!emailParam) return;
    setResending(true);
    try {
      await sendVerificationEmail({
        email: emailParam,
        callbackURL: "/verify-email",
      });
      toast("success", t.auth.errors.verificationSent);
    } catch (err) {
      const msg = isAbortError(err)
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
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-emerald-500/10">
            <CheckCircle2 className="size-6 text-emerald-500" />
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

        {emailParam && (
          <Button
            variant="outline"
            className="mt-6"
            onClick={handleResend}
            disabled={resending}
          >
            {resending && <Loader2 className="animate-spin" />}
            {t.auth.verifyEmail.resendVerification}
          </Button>
        )}

        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/login" className="font-medium text-foreground transition-colors hover:underline">
            {t.auth.verifyEmail.backToSignIn}
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
