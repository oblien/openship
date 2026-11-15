import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { MIGRATION_SOURCES, getMigrationSource } from "./migration-sources";
import { renderOgImage } from "./og-image";

// Bundle the same approved marks used on the guide pages. Read local assets once;
// generating a social card never needs a provider/CDN request or an API credential.
const logos = await Promise.all(
  [...new Set(MIGRATION_SOURCES.flatMap((source) => source.logos))].map(async (logo) => ({
    id: logo,
    name: logo.charAt(0).toUpperCase() + logo.slice(1),
    src: `data:image/svg+xml;base64,${await readFile(
      join(process.cwd(), "public/provider-logos", `${logo}.svg`),
      "base64",
    )}`,
  })),
);

export function renderMigrationOgImage(slug?: string) {
  const source = slug ? getMigrationSource(slug) : undefined;
  if (slug && !source) notFound();
  return renderOgImage({
    eyebrow: "Move to OpenShip",
    title: source ? `Move from ${source.name}.` : "Your stack. A new home.",
    subtitle: source
      ? source.summary
      : "Bring apps and data from Railway, Vercel, Coolify or Dokploy. Run them on Cloud or your own servers.",
    logos: source ? logos.filter((logo) => source.logos.includes(logo.id)) : logos,
  });
}
