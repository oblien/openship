import type { Metadata, ResolvingMetadata } from "next";

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
  return {
    ...metadata,
    ...(metadata.openGraph && {
      openGraph: {
        ...metadata.openGraph,
        images: metadata.openGraph.images ?? inherited.openGraph?.images,
      },
    }),
    ...(metadata.twitter && {
      twitter: {
        ...metadata.twitter,
        images:
          metadata.twitter.images ??
          metadata.openGraph?.images ??
          inherited.twitter?.images ??
          inherited.openGraph?.images,
      },
    }),
  };
}
