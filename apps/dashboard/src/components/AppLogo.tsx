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
  // simpleicons removed the Slack + Microsoft Teams brand marks (both 404 on the
  // CDN now), so resolve their official colored favicons like convex above —
  // otherwise they fall back to a generic monochrome glyph.
  slack: { src: "https://www.google.com/s2/favicons?domain=slack.com&sz=128" },
  microsoftteams: { src: "https://www.google.com/s2/favicons?domain=teams.microsoft.com&sz=128" },
  // Supabase's official mark, rendered in its brand green by the simpleicons CDN.
  supabase: { slug: "supabase" },
  pocketbase: { slug: "pocketbase" },
  mongodb: { slug: "mongodb" },
  n8n: { slug: "n8n" },
  // Ghost's brand mark is near-black — invert it on the dark themes so it
  // stays visible (it's monochrome, so invert = clean white). Colored logos
  // are left alone.
  ghost: { slug: "ghost", darkInvert: true },
  "uptime-kuma": { slug: "uptimekuma" },
  // Vaultwarden's shield mark is pure #000000, so it sinks into a dark tile — invert
  // renders it clean white there (single flat color, nothing to distort).
  vaultwarden: { slug: "vaultwarden", darkInvert: true },
  metabase: { slug: "metabase" },
  // Directus' rabbit is near-black (#263238) → invert it on the dark themes.
  directus: { slug: "directus", darkInvert: true },
  // simpleicons DROPPED the NocoDB mark — `cdn.simpleicons.org/nocodb` 404s now, so the
  // slug it used to resolve left the card on the generic Boxes glyph. Vendored brand SVG
  // instead (indigo gradient, so it reads on light and dark alike — no invert).
  nocodb: { src: "/app-logos/nocodb.svg" },
  // Grafana's mark stays colored; Gitea's tea-cup mark is fine as-is.
  grafana: { slug: "grafana" },
  gitea: { slug: "gitea" },
  minio: { slug: "minio" },
  freshrss: { slug: "freshrss" },
  excalidraw: { slug: "excalidraw" },
  qdrant: { slug: "qdrant" },
  // Neon's mark is brand green (#34D59A) — colored, stays visible everywhere.
  neon: { slug: "neon" },
  // PostHog + Umami marks are near-black (#000000) → darkInvert flips them to
  // white on the dark/dim tiles so they don't vanish. Meilisearch is brand pink.
  posthog: { slug: "posthog", darkInvert: true },
  meilisearch: { slug: "meilisearch" },
  umami: { slug: "umami", darkInvert: true },
  // Valkey (catalog id "redis") has no simpleicons mark → use its official
  // favicon like convex/slack above. Aliased under "valkey" too for slug callers.
  redis: { src: "https://www.google.com/s2/favicons?domain=valkey.io&sz=128" },
  valkey: { src: "https://www.google.com/s2/favicons?domain=valkey.io&sz=128" },
  // Kafka's catalog id is "kafka"; its simpleicons brand slug is "apachekafka".
  // The mark is near-black (brand color #231F20), so it vanishes on the dark/dim
  // tiles — darkInvert flips it to near-white there (dark on light themes as-is).
  kafka: { slug: "apachekafka", darkInvert: true },
  // Buzz (block/buzz) — vendored bee mark (its own favicon, OS-recolor stripped).
  // Monochrome near-black, so darkInvert flips it to light on the dark themes.
  buzz: { slug: undefined, src: "/app-logos/buzz.svg", darkInvert: true },
  // simpleicons carries a mark for none of these four (Microsoft's VS Code icon is gone
  // from the CDN too), and ClickHouse's exists only in brand yellow — unreadable on the
  // light theme, see the note in clickhouse.svg. All four are vendored under
  // public/app-logos, so they also render air-gapped. Stirling PDF, IT-Tools and
  // ClickHouse are square marks carrying their own background → `fill`.
  clickhouse: { src: "/app-logos/clickhouse.svg", fill: true },
  // code-server = VS Code in the browser, so it wears the VS Code logo. NO darkInvert:
  // the mark is brand blue, and inverting it would come out orange.
  "code-server": { src: "/app-logos/code-server.svg" },
  "it-tools": { src: "/app-logos/it-tools.png", fill: true },
  "stirling-pdf": { src: "/app-logos/stirling-pdf.svg", fill: true },
  // openship-native mail stack — its own brand mark, a full-bleed square icon.
  // "mail" is the engine flow; "webmail" the catalog app that installs the client.
  // "mail-webmail" is the retired template id still stored on pre-catalog webmail
  // project rows — keep it so those rows keep their logo.
  "mail-webmail": { src: "/apple-touch-icon.png", fill: true },
  webmail: { src: "/apple-touch-icon.png", fill: true },
  mail: { src: "/apple-touch-icon.png", fill: true },
  // The control plane self-registered as an app (CLI self-deploy) — Openship's
  // own brand mark, a full-bleed square icon.
  openship: { src: "/apple-touch-icon.png", fill: true },
  // MindWire's own monochrome mark is vendored so the catalog works offline and
  // the brand stays legible on both dashboard themes.
  mindwire: { src: "/app-logos/mindwire.svg", fill: true },
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
