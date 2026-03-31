"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signUp } from "@/lib/auth-client";
import { useToast } from "@/components/toast";
import { useI18n } from "@/components/i18n-provider";
import { AuthShell } from "@/components/auth-shell";
import { OAuthButtons } from "@/components/oauth-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { isNetworkError } from "@/lib/api";

export default function RegisterPage() {
  return (
    <Suspense fallback={
      <AuthShell>
        <div className="flex justify-center py-8"><div className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" /></div>
      </AuthShell>
    }>
      <RegisterPageInner />
    </Suspense>
  );
}

function RegisterPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { t } = useI18n();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  // Desktop callback: after signup, redirect to authorize page (has state + PKCE)
  // Self-hosted connect: after signup, redirect directly to handoff (no state)
  const callback = searchParams.get("callback");
  const appParam = searchParams.get("app");
  const machineParam = searchParams.get("machine");
  const stateParam = searchParams.get("state");
  const codeChallengeParam = searchParams.get("code_challenge");
  const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

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

    if (password.length < 8) {
      toast("error", t.auth.errors.passwordMin);
      return;
    }

    setLoading(true);
    try {
      const result = await signUp.email({
        name,
        email,
        password,
      });
      if (result.error) {
        if (result.error.message?.toLowerCase().includes("verify")) {
          router.push(`/verify-email?email=${encodeURIComponent(email)}`);
          return;
        }
        toast("error", result.error.message ?? t.auth.errors.createFailed);
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

  return (
    <AuthShell>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t.auth.register.title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t.auth.register.subtitle}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="reg-name">{t.auth.register.nameLabel}</Label>
          <Input
            id="reg-name"
            type="text"
            autoComplete="name"
            placeholder={t.auth.register.namePlaceholder}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="reg-email">{t.auth.register.emailLabel}</Label>
          <Input
            id="reg-email"
            type="email"
            autoComplete="email"
            placeholder={t.auth.register.emailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="reg-password">{t.auth.register.passwordLabel}</Label>
          <div className="relative">
            <Input
              id="reg-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder={t.auth.register.passwordPlaceholder}
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

        <Button type="submit" disabled={loading} className="mt-1 w-full">
          {loading && <Loader2 className="animate-spin" />}
          {loading ? t.auth.register.submitting : t.auth.register.submit}
        </Button>
      </form>

      <OAuthButtons callbackURL={postLoginUrl ?? "/"} />

      <p className="mt-8 text-center text-sm text-muted-foreground">
        {t.auth.register.hasAccount}{" "}
        <Link
          href={callback
            ? `/login?${new URLSearchParams({
                callback,
                ...(appParam ? { app: appParam } : {}),
                ...(machineParam ? { machine: machineParam } : {}),
                ...(stateParam ? { state: stateParam } : {}),
                ...(codeChallengeParam ? { code_challenge: codeChallengeParam } : {}),
              }).toString()}`
            : "/login"}
          className="font-medium text-foreground transition-colors hover:underline"
        >
          {t.auth.register.signIn}
        </Link>
      </p>
    </AuthShell>
  );
}
