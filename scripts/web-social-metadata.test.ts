import { describe, expect, it } from "bun:test";
import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "../apps/web/src/lib/social-metadata";
import { generateMetadata as pricingMetadata } from "../apps/web/src/app/(site)/(marketing)/pricing/layout";

const ogImages = [
  {
    url: "https://openship.io/opengraph-image-group?revision=123",
    width: 1200,
    height: 630,
    alt: "Openship",
  },
];
const twitterImages = [
  { url: "https://openship.io/twitter-image-group?revision=456", alt: "Openship" },
];
const parent = Promise.resolve({
  openGraph: { images: ogImages },
  twitter: { images: twitterImages },
}) as ResolvingMetadata;

describe("page social previews", () => {
  it("includes both crawler images in Pricing's actual metadata", async () => {
    const result = await pricingMetadata({}, parent);
    expect(result.openGraph?.images).toEqual(ogImages);
    expect(result.twitter?.images).toEqual(twitterImages);
    expect(result.title).toBe("Pricing");
    expect(result.alternates?.canonical).toBe("/pricing");
  });

  it("keeps Next's resolved image URLs when a page overrides its social metadata", async () => {
    const page: Metadata = {
      title: "Pricing",
      alternates: { canonical: "/pricing" },
      openGraph: {
        title: "Pricing - Openship",
        description: "Cloud plans",
        url: "/pricing",
        type: "website",
      },
      twitter: { title: "Pricing - Openship", card: "summary_large_image" },
    };
    const result = await inheritSocialImages(page, parent);
    expect(result).toEqual({
      ...page,
      openGraph: { ...page.openGraph, images: ogImages },
      twitter: { ...page.twitter, images: twitterImages },
    });
    expect(page.openGraph).not.toHaveProperty("images");
    expect(page.twitter).not.toHaveProperty("images");
  });

  it("preserves page-specific images and article metadata", async () => {
    const page: Metadata = {
      openGraph: { type: "article", publishedTime: "2026-10-22", images: ["/article-cover.png"] },
      twitter: { card: "summary_large_image", images: ["/article-twitter.png"] },
    };
    expect(await inheritSocialImages(page, parent)).toEqual(page);
  });

  it("uses a custom Open Graph image for Twitter when no separate image is set", async () => {
    const result = await inheritSocialImages(
      {
        openGraph: { images: ["/article-cover.png"] },
        twitter: { card: "summary_large_image" },
      },
      parent,
    );
    expect(result.twitter?.images).toEqual(["/article-cover.png"]);
  });

  it("leaves untouched social fields for Next to inherit, including explicit opt-outs", async () => {
    for (const page of [
      { title: "Support", robots: { index: false } },
      { openGraph: null, twitter: null },
      { openGraph: { images: [] }, twitter: { images: [] } },
    ]) {
      expect(await inheritSocialImages(page, parent)).toEqual(page);
    }
  });
});
