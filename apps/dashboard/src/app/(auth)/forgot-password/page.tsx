"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { emailOtp } from "@/lib/auth-client";
import { useToast } from "@/components/toast";
import { useI18n } from "@/components/i18n-provider";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Loader2 } from "lucide-react";
import { isNetworkError } from "@/lib/api";

export default function ForgotPasswordPage() {
  const { toast } = useToast();
  const { t } = useI18n();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      // A CODE, not a link. `redirectTo` is gone with the link flow — the user is
      // sent straight to the form that asks for the code, so the only thing that
      // has to survive the trip is six digits they can read off their screen.
      const result = await emailOtp.sendVerificationOtp({ email, type: "forget-password" });
      if (result?.error) {
        toast("error", result.error.message ?? t.auth.errors.generic);
        return;
      }
      // Straight to the code form. There is no "check your inbox" waiting room: it
      // announced a link, and the page it sends you to already says a code was sent
      // and to where. Carrying the address in the query saves asking twice — it is
      // not the credential, the code is.
      router.push(`/reset-password?email=${encodeURIComponent(email)}`);
    } catch (err) {
      toast("error", isNetworkError(err)
        ? t.auth.errors.serverUnreachable
        : t.auth.errors.generic);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
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
    </AuthShell>
  );
}
