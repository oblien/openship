import { useCopy } from "@/i18n/use-copy";

import { IllustratedLink } from "@/components/marketing/illustrated-link";
import type { Feature } from "@/lib/features";

/** One feature row for the catalog and related-feature navigation. */
export function FeatureLink({ feature, tabIndex }: { feature: Feature; tabIndex?: number }) {
  const copy = useCopy();

  return (
    <IllustratedLink
      href={`/features/${feature.slug}`}
      tabIndex={tabIndex}
      illustration={feature.illustration}
      title={copy(feature.title)}
      description={copy(feature.tagline)}
      note={feature.availability ? "Availability details inside" : undefined}
    />
  );
}
