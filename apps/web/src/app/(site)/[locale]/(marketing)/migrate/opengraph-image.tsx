import { renderMigrationOgImage } from "@/lib/migration-og";
import { OG_SIZE } from "@/lib/og-image";

export const alt = "Migrate from Railway, Vercel, Coolify or Dokploy to OpenShip";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OgImage() {
  return renderMigrationOgImage();
}
