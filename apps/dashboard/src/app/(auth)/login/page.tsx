"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "@/lib/auth-client";
import { useToast } from "@/components/toast";
import { useI18n } from "@/components/i18n-provider";
import { useAuthContext } from "../providers";
import { AuthShell } from "@/components/auth-shell";
import { OAuthButtons } from "@/components/oauth-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Loader2, ExternalLink } from "lucide-react";
import { isNetworkError } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { t } = useI18n();
  const { authMode, cloudAuthUrl, selfHosted } = useAuthContext();

  const isDesktop = typeof window !== "undefined" && !!(window as any).desktop?.isDesktop;
  const handleBack = isDesktop ? () => (window as any).desktop.reset() : undefined;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const callbackError = searchParams.get("error");

  // Desktop callback: after login, redirect to authorize page (has state + PKCE)
  // Self-hosted connect: after login, redirect directly to handoff (no state)
  const callback = searchParams.get("callback");
  const appParam = searchParams.get("app");
  const machineParam = searchParams.get("machine");
  const stateParam = searchParams.get("state");
  const codeChallengeParam = searchParams.get("code_challenge");
  const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

  // Desktop flow (state present) → authorize page with explicit consent
  // Self-hosted connect (no state) → direct handoff
  const postLoginUrl = callback
    ? stateParam
      ? `/authorize?${new URLSearchParams({
          callback,
          ...(appParam ? { app: appParam } : {}),
          ...(machineParam ? { machine: machineParam } : {}),
          ...(stateParam ? { state: stateParam } : {}),
          ...(codeChallengeParam ? { code_challenge: codeChallengeParam } : {}),
        }).toString()}`
      : `${API_URL}/api/cloud/connect-handoff?redirect=${encodeURIComponent(callback)}`
    : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await signIn.email({ email, password });
      if (result.error) {
        toast("error", result.error.message ?? t.auth.errors.invalidCredentials);
      } else if (postLoginUrl) {
        window.location.href = postLoginUrl;
      } else {
        router.push("/");
      }
    } catch (err) {
      toast("error", isNetworkError(err)
        ? t.auth.errors.serverUnreachable
        : t.auth.errors.generic);
    } finally {
      setLoading(false);
    }
  }

  /* ── Zero-auth mode (desktop): auto-redirect to create session ── */
  if (authMode === "none") {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
    // Redirect to the desktop-login endpoint which creates a real
    // session cookie and redirects back to the dashboard.
    if (typeof window !== "undefined") {
      window.location.href = `${apiUrl}/api/auth/desktop-login`;
    }
    return (
      <AuthShell>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </AuthShell>
    );
  }

  /* ── Cloud mode (desktop): redirect to Openship Cloud for all auth ── */
  if (authMode === "cloud") {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
    const callbackUrl = `${apiUrl}/api/auth/cloud-callback`;
    const cloudLoginUrl = `${cloudAuthUrl}/login?callback=${encodeURIComponent(callbackUrl)}`;

    return (
      <AuthShell onBack={handleBack}>
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {t.auth.login.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with your Openship account to continue.
          </p>
        </div>

        {callbackError && (
          <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {callbackError === "missing_code"
              ? "Authentication was cancelled."
              : "Authentication failed. Please try again."}
          </div>
        )}

        <Button
          className="w-full"
          size="lg"
          onClick={() => { window.location.href = cloudLoginUrl; }}
        >
          <ExternalLink className="mr-2 size-4" />
          Sign in with Openship
        </Button>
      </AuthShell>
    );
  }

  /* ── Local mode: email/password form ── */
  return (
    <AuthShell onBack={handleBack}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t.auth.login.title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t.auth.login.subtitle}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="login-email">{t.auth.login.emailLabel}</Label>
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            placeholder={t.auth.login.emailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="login-password">{t.auth.login.passwordLabel}</Label>
            <Link
              href="/forgot-password"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {t.auth.login.forgot}
            </Link>
          </div>
          <div className="relative">
            <Input
              id="login-password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder={t.auth.login.passwordPlaceholder}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
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

        <Button type="submit" disabled={loading} className="mt-1 w-full">
          {loading && <Loader2 className="animate-spin" />}
          {loading ? t.auth.login.submitting : t.auth.login.submit}
        </Button>
      </form>

      {/* OAuth only for SaaS (cloud-hosted) — hidden on self-hosted */}
      {!selfHosted && <OAuthButtons callbackURL={postLoginUrl ?? "/"} />}

      <p className="mt-8 text-center text-sm text-muted-foreground">
        {t.auth.login.noAccount}{" "}
        <Link
          href={callback
            ? `/register?${new URLSearchParams({
                callback,
                ...(appParam ? { app: appParam } : {}),
                ...(machineParam ? { machine: machineParam } : {}),
                ...(stateParam ? { state: stateParam } : {}),
                ...(codeChallengeParam ? { code_challenge: codeChallengeParam } : {}),
              }).toString()}`
            : "/register"}
          className="font-medium text-foreground transition-colors hover:underline"
        >
          {t.auth.login.createOne}
        </Link>
      </p>
    </AuthShell>
  );
}
