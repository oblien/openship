import { renderOgImage, OG_SIZE } from "@/lib/og-image";

import { referralCard } from "@/lib/share-cards";

export const alt = "OpenShip Referral. Good tools are worth sharing.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OgImage() {
  return renderOgImage(referralCard);
}
