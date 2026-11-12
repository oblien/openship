import { renderOgImage, OG_SIZE } from "@/lib/og-image";

export const alt = "OpenShip pricing — Cloud plans, server management and free self-hosting";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OgImage() {
  return renderOgImage({
    eyebrow: "Pricing",
    title: "Room to build. Room to grow.",
    subtitle: "Cloud plans, server management and free self-hosting. Choose where your apps run.",
  });
}
