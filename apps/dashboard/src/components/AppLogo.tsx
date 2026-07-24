"use client";

import { useState } from "react";
import { Boxes, type LucideIcon } from "lucide-react";

/**
 * Per-app logo source. `src` wins (official logo URL); otherwise `slug` resolves
 * to a simpleicons brand mark. Convex uses its official favicon because the
 * simpleicons "convex" glyph renders as a red mask, not the real orange logo.
 */
export const APP_LOGO: Record<
  string,
  { slug?: string; src?: string; fill?: boolean; darkInvert?: boolean }
> = {
  convex: { src: "https://www.google.com/s2/favicons?domain=convex.dev&sz=128" },
  // Supabase's official mark, rendered in its brand green by the simpleicons CDN.
  supabase: { slug: "supabase" },
  mongodb: { slug: "mongodb" },
  n8n: { slug: "n8n" },
  // Ghost's brand mark is near-black — invert it on the dark themes so it
  // stays visible (it's monochrome, so invert = clean white). Colored logos
  // are left alone.
  ghost: { slug: "ghost", darkInvert: true },
  "uptime-kuma": { slug: "uptimekuma" },
  vaultwarden: { slug: "vaultwarden" },
  metabase: { slug: "metabase" },
  directus: { slug: "directus" },
  nocodb: { slug: "nocodb" },
  // Grafana's mark stays colored; Gitea's tea-cup mark is fine as-is.
  grafana: { slug: "grafana" },
  gitea: { slug: "gitea" },
  minio: { slug: "minio" },
  freshrss: { slug: "freshrss" },
  excalidraw: { slug: "excalidraw" },
  // Buzz (block/buzz) — vendored bee mark (its own favicon, OS-recolor stripped).
  // Monochrome near-black, so darkInvert flips it to light on the dark themes.
  buzz: { slug: undefined, src: "/app-logos/buzz.svg", darkInvert: true },
  // code-server / IT-Tools / Stirling-PDF have no reliable simpleicons mark →
  // they fall back to the monochrome Boxes glyph.
  // openship-native mail stack — its own brand mark, a full-bleed square icon.
  // Both the catalog id ("mail") and the installed-app id ("mail-webmail").
  "mail-webmail": { src: "/apple-touch-icon.png", fill: true },
  mail: { src: "/apple-touch-icon.png", fill: true },
  // The control plane self-registered as an app (CLI self-deploy) — Openship's
  // own brand mark, a full-bleed square icon.
  openship: { src: "/apple-touch-icon.png", fill: true },
};

/**
 * Brand logo for a catalog app. Resolves an official URL / simpleicons mark and
 * gracefully falls back to a monochrome lucide icon (offline / air-gapped /
 * unknown app). Keeps the UI clean while adding a touch of real color.
 */
export function AppLogo({
  appId,
  slug,
  src,
  icon: Icon = Boxes,
  className = "size-5",
}: {
  appId?: string;
  slug?: string;
  src?: string;
  icon?: LucideIcon;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // Resolve config by appId first, then by the bare slug — so callers that pass
  // only a `slug` (e.g. the migrate-sources brand row) can still pick up a
  // vendored src override for brands simpleicons doesn't carry.
  const cfg = APP_LOGO[appId ?? ""] ?? APP_LOGO[slug ?? ""];
  const resolvedSlug = slug ?? cfg?.slug;
  const url = src ?? cfg?.src ?? (resolvedSlug ? `https://cdn.simpleicons.org/${resolvedSlug}` : undefined);

  if (!url || failed) return <Icon className={`${className} text-muted-foreground`} />;
  // Full-bleed square marks (own background) fill the tile; transparent brand
  // glyphs stay at the requested size. Dark monochrome marks invert on the dark
  // themes so they don't vanish against a dark tile.
  // Full-bleed marks round to the tile they sit in (rounded-[inherit] takes the
  // parent tile's radius) so they don't render as a hard square.
  // Non-fill marks: object-contain so a non-square brand SVG fits the box without
  // squishing (square favicons/simpleicons are unaffected).
  const base = cfg?.fill ? "size-full object-cover rounded-[inherit]" : `${className} object-contain`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      className={cfg?.darkInvert ? `${base} dark:invert dim:invert` : base}
      onError={() => setFailed(true)}
    />
  );
}
