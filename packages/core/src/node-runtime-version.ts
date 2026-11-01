import { minVersion, subset, validRange } from "semver";

/** Pick an image tag wholly contained in engines.node. Keep the platform
 * default when its major satisfies the range; never splice a raw range into an image. */
export function nodeImageForEngine(defaultImage: string, engine: unknown): string {
  if (typeof engine !== "string" || engine.length > 500 || !/^node:\d+$/.test(defaultImage))
    return defaultImage;
  const range = validRange(engine);
  if (!range) return defaultImage;
  const fallbackMajor = defaultImage.slice(5);
  if (subset(`${fallbackMajor}.x`, range)) return defaultImage;
  const minimum = minVersion(range);
  if (!minimum || minimum.major < 1 || minimum.prerelease.length) return defaultImage;
  for (const tag of [String(minimum.major), `${minimum.major}.${minimum.minor}`, minimum.version]) {
    const candidate = tag.split(".").length === 3 ? tag : `${tag}.x`;
    if (subset(candidate, range)) return `node:${tag}`;
  }
  return defaultImage;
}
