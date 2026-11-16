import { renderOgImage, OG_SIZE } from "@/lib/og-image";

export const alt = "Git to OpenShip";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OgImage() {
  return renderOgImage({ title: "Git → OpenShip", subtitle: "openship.io/migrate/from-git" });
}
