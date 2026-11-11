import { IllustratedLink } from "@/components/marketing/illustrated-link";
import type { Feature } from "@/lib/features";

/** One feature row for the catalog and related-feature navigation. */
export function FeatureLink({ feature }: { feature: Feature }) {
  return (
    <IllustratedLink
      href={`/features/${feature.slug}`}
      illustration={feature.slug}
      title={feature.title}
      description={feature.tagline}
      note={feature.availability ? "Availability details inside" : undefined}
    />
  );
}
