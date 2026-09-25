"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import { useState } from "react";
import { signIn } from "@/lib/auth-client";
import { isAbortError } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import {
  renderableOAuthProviders,
  type AdvertisedAuthProvider,
  type RenderableOAuthProviderId,
} from "@/lib/auth-providers";

/** Icon per renderable provider. The label comes from i18n (`t.auth.oauth[id]`),
 *  so adding a provider means one entry here and one key there. */
const PROVIDER_ICONS: Record<RenderableOAuthProviderId, IconName> = {
  github: "github",
  google: "google",
};

/**
 * Shared OAuth buttons, rendered from the provider list the SERVER advertises
 * (GET /health/env → `authProviders`, plumbed through the auth layout's
 * context). Renders nothing at all — no divider either — when the list is
 * empty, so callers can mount this unconditionally instead of guessing from
 * `selfHosted` which providers exist.
 *
 * Pass callbackURL to override the default post-OAuth redirect.
 */
export function OAuthButtons({
  providers,
  callbackURL = "/",
}: {
  providers: readonly AdvertisedAuthProvider[] | undefined;
  callbackURL?: string;
}) {
  const { toast } = useToast();
  const { t } = useI18n();
  const [loading, setLoading] = useState<RenderableOAuthProviderId | null>(null);

  const visible = renderableOAuthProviders(providers);

  async function handleOAuth(provider: RenderableOAuthProviderId) {
    setLoading(provider);
    try {
      // Resolve callbackURL against the DASHBOARD origin. Better Auth resolves
      // a relative callback against its baseURL — the API host — so in
      // split-origin SaaS (app.* vs api.*) a bare "/" dead-ends on the API
      // subdomain after the OAuth callback instead of returning to the app.
      const appOrigin = window.location.origin;
      const cb = new URL(callbackURL, appOrigin).toString();
      // better-auth resolves sign-in errors into `{ error }` rather than
      // throwing, so inspecting the return value is what actually surfaces a
      // misconfigured/failed provider — the try/catch only covers thrown
      // network/abort errors. Without this the spinner spun forever.
      const { error } = await signIn.social({
        provider,
        callbackURL: cb,
        // First-time OAuth users take the newUser branch; keep them on the app.
        newUserCallbackURL: cb,
        errorCallbackURL: new URL("/login", appOrigin).toString(),
      });
      if (error) {
        toast("error", error.message ?? t.auth.errors.oauthFailed);
        setLoading(null);
      }
      // Success → better-auth redirects the browser; keep the spinner until the
      // navigation happens rather than flashing the button back.
    } catch (err) {
      const msg = isAbortError(err)
        ? t.auth.errors.serverUnreachable
        : t.auth.errors.oauthFailed;
      toast("error", msg);
      setLoading(null);
    }
  }

  // Nothing configured server-side → no divider, no buttons. This is what makes
  // the callers' unconditional `<OAuthButtons providers={…} />` safe.
  if (visible.length === 0) return null;

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
        {visible.map((provider) => (
          <Button
            key={provider}
            variant="ghost"
            disabled={loading !== null}
            onClick={() => handleOAuth(provider)}
            className="w-full border-0 bg-foreground/[0.04] hover:bg-foreground/[0.08]"
          >
            {loading === provider ? <UiIcon name="spinner" className="animate-spin" /> : <UiIcon name={PROVIDER_ICONS[provider]} size={17} />}
            {t.auth.oauth[provider]}
          </Button>
        ))}
      </div>
    </>
  );
}
