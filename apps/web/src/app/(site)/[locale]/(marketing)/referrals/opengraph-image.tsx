import { renderOgImage, OG_SIZE } from "@/lib/og-image";

export const runtime = "edge";
export const alt = "OpenShip Referral. Good tools are worth sharing.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OgImage() {
  return renderOgImage({
    eyebrow: "Referral program",
    title: "Good tools are worth sharing.",
    subtitle: "Introduce someone to OpenShip. A small thank-you for making the connection.",
  });
}
