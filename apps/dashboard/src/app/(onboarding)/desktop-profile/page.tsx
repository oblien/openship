"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Loader2, UserRound } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { startDesktopCloudAuth } from "@/lib/cloud-auth";

export default function DesktopProfileSignInPage() {
  const bridge = typeof window !== "undefined" ? window.desktop : undefined;
  const [profiles, setProfiles] = useState<DesktopProfilesState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge?.profiles) return;
    void bridge.profiles
      .list()
      .then(setProfiles)
      .catch(() => setError("Profiles could not be loaded."));
  }, [bridge]);

  const active = useMemo(
    () => profiles?.profiles.find((profile) => profile.id === profiles.activeProfileId) ?? null,
    [profiles],
  );

  async function signIn() {
    if (!bridge?.onboarding) return;
    setLoading(true);
    setError(null);
    const result = await startDesktopCloudAuth({ desktop: bridge });
    if (!result.ok) {
      setError(
        result.reason === "start_failed"
          ? "Could not open Openship sign-in."
          : "Sign-in did not finish. Try again.",
      );
      setLoading(false);
    }
  }

  if (!bridge?.profiles) {
    return (
      <AuthShell>
        <p className="text-sm text-muted-foreground">
          Desktop profiles are only available in the Openship app.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="mb-6 text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full border border-border/70 bg-background">
          <UserRound className="size-5" />
        </div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Desktop profile
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
          {active?.name ?? "Profile"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Sign in for this profile. Projects, servers, and deployments remain shared.
        </p>
      </div>

      <Button
        className="w-full"
        size="lg"
        disabled={loading || !active}
        onClick={() => void signIn()}
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ExternalLink className="size-4" />
        )}
        {loading ? "Waiting for sign-in…" : "Sign in with Openship"}
      </Button>

      <button
        type="button"
        disabled={loading}
        onClick={() => void bridge.profiles?.useLocal()}
        className="mt-3 w-full rounded-xl px-4 py-2.5 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
      >
        Use this profile locally only
      </button>

      {error && (
        <p className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {(profiles?.profiles.length ?? 0) > 1 && (
        <div className="mt-7 border-t border-border/50 pt-5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Use a saved profile
          </p>
          <div className="space-y-1">
            {profiles?.profiles.map((profile) => {
              const isCurrent = profile.id === profiles.activeProfileId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  disabled={loading || isCurrent}
                  onClick={() => void bridge.profiles?.switch(profile.id)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start hover:bg-muted/50 disabled:opacity-60"
                >
                  <span className="flex size-7 items-center justify-center rounded-full border border-border/70 text-xs font-semibold uppercase">
                    {profile.name[0]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {profile.name}
                  </span>
                  {isCurrent && <Check className="size-4 text-primary" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </AuthShell>
  );
}
