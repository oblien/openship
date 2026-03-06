"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { resetPassword } from "@/lib/auth-client";
import { useToast } from "@/components/toast";
import { useI18n } from "@/components/i18n-provider";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

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
  const token = searchParams.get("token") ?? "";
  const { toast } = useToast();
  const { t } = useI18n();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

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
    if (!token) {
      toast("error", t.auth.errors.invalidToken);
      return;
    }

    setLoading(true);
    try {
      const result = await resetPassword({ newPassword: password, token });
      if (result.error) {
        toast("error", result.error.message ?? t.auth.errors.resetFailed);
      } else {
        setDone(true);
      }
    } catch (err) {
      toast("error", isAbortError(err)
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
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-emerald-500/10">
            <CheckCircle2 className="size-6 text-emerald-500" />
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
          {t.auth.resetPassword.subtitle}
        </p>
      </div>

      {!token && (
        <div className="mb-4 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t.auth.resetPassword.noTokenError.replace(
            "{link}",
            "",
          )}
          <Link href="/forgot-password" className="underline">
            {t.auth.resetPassword.noTokenLink}
          </Link>
          .
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
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
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              tabIndex={-1}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
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

        <Button type="submit" disabled={loading || !token} className="mt-1 w-full">
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
