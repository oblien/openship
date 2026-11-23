import type { Metadata, ResolvingMetadata } from "next";
import { withoutLocale } from "../i18n/routing";
import { shareImageFor } from "./share-cards";

/**
 * Next replaces nested social metadata rather than merging it. Keep the resolved
 * parent image URLs (including Next's route-group hashes) when customizing a page.
 * Pages with their own file-based images, like Download, use that convention directly.
 */
export async function inheritSocialImages(
  metadata: Metadata,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const inherited = await parent;
  const canonical = metadata.alternates?.canonical;
  const path = typeof canonical === "string" ? new URL(canonical, "https://openship.io") : null;
  const card =
    path?.origin === "https://openship.io"
      ? shareImageFor(withoutLocale(path.pathname))
      : undefined;
  const images = card && [
    {
      ...card,
      alt:
        card.alt ??
        (typeof metadata.openGraph?.title === "string" ? metadata.openGraph.title : "OpenShip"),
    },
  ];
  return {
    ...metadata,
    ...(metadata.openGraph && {
      openGraph: {
        ...metadata.openGraph,
        images: metadata.openGraph.images ?? images ?? inherited.openGraph?.images,
      },
    }),
    ...(metadata.twitter && {
      twitter: {
        ...metadata.twitter,
        images:
          metadata.twitter.images ??
          metadata.openGraph?.images ??
          images ??
          inherited.twitter?.images ??
          inherited.openGraph?.images,
      },
    }),
  };
}
