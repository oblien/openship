import { expect, test } from "bun:test";
import { FEATURES } from "../src/lib/features";
import { objectArtwork, subjectForFeature } from "../src/lib/og-objects";
import { deployCard, referralCard, sectionCards } from "../src/lib/share-cards";

test("marketing destinations have distinct subjects independent of their headlines", () => {
  const cards = [deployCard, referralCard, ...Object.values(sectionCards)];
  const subjects = cards.map(({ art }) =>
    "object" in art ? objectArtwork(art.object) : art.feature,
  );
  expect(new Set(subjects).size).toBe(cards.length);
});

test("each feature has its own share illustration even when its dashboard icon is shared", () => {
  const subjects = FEATURES.map((feature) => {
    const object = subjectForFeature(feature.slug);
    return object ? objectArtwork(object) : feature.illustration;
  });
  expect(new Set(subjects).size).toBe(FEATURES.length);
});
