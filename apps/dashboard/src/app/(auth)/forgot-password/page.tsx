"use client";

import { useState } from "react";
import Link from "next/link";
import { forgetPassword } from "@/lib/auth-client";
import { useToast } from "@/components/toast";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Loader2, Mail } from "lucide-react";

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export default function ForgotPasswordPage() {
  const { toast } = useToast();
  const { t } = useI18n();

  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await forgetPassword({
        email,
        redirectTo: "/reset-password",
      });
      setSent(true);
    } catch (err) {
      toast("error", isAbortError(err)
        ? t.auth.errors.serverUnreachable
        : t.auth.errors.generic);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      {sent ? (
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-secondary">
            <Mail className="size-6 text-foreground" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {t.auth.forgotPassword.sentTitle}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {interpolate(t.auth.forgotPassword.sentDescription, { email })}
          </p>
          <Button
            variant="outline"
            className="mt-6"
            onClick={() => {
              setSent(false);
              setEmail("");
            }}
          >
            {t.auth.forgotPassword.tryDifferentEmail}
          </Button>
          <p className="mt-6 text-sm text-muted-foreground">
            <Link href="/login" className="font-medium text-foreground transition-colors hover:underline">
              {t.auth.forgotPassword.backToSignIn}
            </Link>
          </p>
        </div>
      ) : (
        <>
          <div className="mb-6">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              {t.auth.forgotPassword.title}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.auth.forgotPassword.subtitle}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="forgot-email">{t.auth.forgotPassword.emailLabel}</Label>
              <Input
                id="forgot-email"
                type="email"
                autoComplete="email"
                placeholder={t.auth.forgotPassword.emailPlaceholder}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <Button type="submit" disabled={loading} className="mt-1 w-full">
              {loading && <Loader2 className="animate-spin" />}
              {loading ? t.auth.forgotPassword.submitting : t.auth.forgotPassword.submit}
            </Button>
          </form>

          <p className="mt-8 text-center text-sm text-muted-foreground">
            <Link
              href="/login"
              className="inline-flex items-center gap-1 font-medium text-foreground transition-colors hover:underline"
            >
              <ArrowLeft className="size-3.5" />
              {t.auth.forgotPassword.backToSignIn}
            </Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
