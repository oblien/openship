import { renderMigrationOgImage } from "@/lib/migration-og";
import { OG_SIZE } from "@/lib/og-image";

export const alt = "Move your apps and data to OpenShip";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OgImage({ params }: { params: Promise<{ slug: string }> }) {
  return renderMigrationOgImage((await params).slug);
}
