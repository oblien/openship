"use client";

import { featureArtwork, type FeatureIllustrationName } from "./artwork";
import { IllustrationFrame, type IllustrationFrameProps } from "./IllustrationFrame";

export interface FeatureIllustrationProps extends Omit<IllustrationFrameProps, "artwork"> {
  name: FeatureIllustrationName;
}

/** Approved flat artwork, shared by the website and application feature surfaces. */
export function FeatureIllustration({ name, ...props }: FeatureIllustrationProps) {
  return <IllustrationFrame artwork={featureArtwork[name]} data-illustration={name} {...props} />;
}
