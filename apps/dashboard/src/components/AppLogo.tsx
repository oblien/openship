"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { AppLogo as SharedAppLogo, APP_LOGO } from "@repo/ui/app-logo";
import { appsApi } from "@/lib/api/apps";

export { APP_LOGO };

let customLogos: Promise<Map<string, string>> | undefined;

/** Custom apps have no APP_LOGO entry; their own template `logo` comes from the catalog (#1507). */
function loadCustomLogos() {
  // Started inside a promise so even a synchronous failure falls back to the default icon.
  customLogos ??= Promise.resolve()
    .then(() => appsApi.catalog())
    .then(
      ({ data }) =>
        new Map(data.filter((app) => app.custom && app.logo).map((app) => [app.id, app.logo])),
    )
    .catch(() => {
      /* diagnostics-ignore: A missing custom logo intentionally uses the logo fallback. */
      customLogos = undefined;
      return new Map<string, string>();
    });
  return customLogos;
}

/** Forget cached custom logos, e.g. after a custom app is added. */
export function refreshCustomAppLogos() {
  customLogos = undefined;
}

export function AppLogo(props: ComponentProps<typeof SharedAppLogo>) {
  const { appId, slug, src } = props;
  const lookup = !!appId && !slug && !src && !(appId in APP_LOGO);
  const [customLogo, setCustomLogo] = useState<string>();
  useEffect(() => {
    setCustomLogo(undefined);
    if (!lookup) return;
    let live = true;
    void loadCustomLogos().then((logos) => {
      if (live) setCustomLogo(logos.get(appId!));
    });
    return () => {
      live = false;
    };
  }, [lookup, appId]);
  return <SharedAppLogo {...props} slug={slug ?? customLogo} />;
}
