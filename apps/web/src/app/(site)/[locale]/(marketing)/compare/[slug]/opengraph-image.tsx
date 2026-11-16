import { notFound } from "next/navigation";
import { getComparison } from "@/lib/comparisons";
import { renderOgImage, OG_SIZE } from "@/lib/og-image";

export const alt = "OpenShip platform comparison";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OgImage({ params }: { params: Promise<{ slug: string }> }) {
  const item = getComparison((await params).slug);
  if (!item) notFound();
  return renderOgImage({
    title: `OpenShip × ${item.group === "vps" ? "VPS" : item.name}`,
    subtitle: `openship.io/compare/${item.slug}`,
  });
}
