import { notFound } from "next/navigation";
import { MIGRATION_SOURCES, getMigrationSource } from "./migration-sources";
import { renderOgImage } from "./og-image";

import { providerMark } from "./og-marks";

export async function renderMigrationOgImage(slug?: string) {
  const source = slug ? getMigrationSource(slug) : undefined;
  if (slug && !source) notFound();
  const ids = source?.logos ?? [...new Set(MIGRATION_SOURCES.flatMap((entry) => entry.logos))];
  const marks = await Promise.all(ids.map((id) => providerMark(id, id)));
  return renderOgImage({
    eyebrow: "Move to OpenShip",
    art: { marks, relation: "transfer" },
    layout: "reverse",
    title: source ? `Move from ${source.name}.` : "Your stack. A new home.",
    subtitle: source
      ? source.summary
      : "Bring apps and data from Railway, Vercel, Coolify or Dokploy. Run them on Cloud or your own servers.",
  });
}
