"use client";

import { useState } from "react";
import { signIn } from "@/lib/auth-client";
import { useToast } from "@/components/toast";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Github, Loader2 } from "lucide-react";

function GoogleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.07 5.07 0 0 1-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Shared OAuth buttons — GitHub + Google.
 * Includes the divider above them.
 */
export function OAuthButtons() {
  const { toast } = useToast();
  const { t } = useI18n();
  const [loading, setLoading] = useState<"github" | "google" | null>(null);

  async function handleOAuth(provider: "github" | "google") {
    setLoading(provider);
    try {
      await signIn.social({ provider, callbackURL: "/" });
    } catch (err) {
      setLoading(null);
      const msg = isAbortError(err)
        ? t.auth.errors.serverUnreachable
        : t.auth.errors.oauthFailed;
      toast("error", msg);
    }
  }

  return (
    <>
      {/* Divider */}
      <div className="my-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="select-none text-xs text-muted-foreground">{t.auth.oauth.or}</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* OAuth buttons */}
      <div className="space-y-2.5">
        <Button
          variant="ghost"
          disabled={loading !== null}
          onClick={() => handleOAuth("github")}
          className="w-full border-0 bg-foreground/[0.04] hover:bg-foreground/[0.08]"
        >
          {loading === "github" ? <Loader2 className="animate-spin" /> : <Github />}
          {t.auth.oauth.github}
        </Button>

        <Button
          variant="ghost"
          disabled={loading !== null}
          onClick={() => handleOAuth("google")}
          className="w-full border-0 bg-foreground/[0.04] hover:bg-foreground/[0.08]"
        >
          {loading === "google" ? <Loader2 className="animate-spin" /> : <GoogleIcon />}
          {t.auth.oauth.google}
        </Button>
      </div>
    </>
  );
}
