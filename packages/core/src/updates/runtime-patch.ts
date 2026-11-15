import { major, minVersion, rcompare, satisfies, valid } from "semver";
import { managedRuntimeImage } from "../runtime-image";

/** Select a signed fix on the current major, preserving each stage's OS variant. */
export function securityRuntimeImages(input: {
  runtime: string;
  currentVersion: string;
  fixed: string;
  buildImage: string;
  runtimeImage: string;
}) {
  if (!valid(input.currentVersion)) return null;
  const builder = managedRuntimeImage(input.buildImage);
  const runtime = managedRuntimeImage(input.runtimeImage);
  const currentMajor = major(input.currentVersion);
  if (
    !builder ||
    !runtime ||
    builder.runtime !== input.runtime ||
    runtime.runtime !== input.runtime ||
    [builder, runtime].some((image) => image.major !== null && image.major !== currentMajor)
  )
    return null;
  // A saved newer selection must never be downgraded to the advisory's minimum.
  const floor = [input.currentVersion, builder.version, runtime.version]
    .filter((version): version is string => !!version)
    .sort(rcompare)[0]!;
  const candidates = input.fixed
    .split("||")
    .flatMap((range) => {
      const candidate = minVersion(`${range.trim()} >=${floor} <${currentMajor + 1}.0.0`);
      return candidate && !candidate.prerelease.length && satisfies(candidate, input.fixed)
        ? [candidate.version]
        : [];
    })
    .sort(rcompare);
  const version = candidates.at(-1);
  if (!version) return null;
  return {
    version,
    buildImage: `${builder.repository}:${version}${builder.variant}`,
    runtimeImage: `${runtime.repository}:${version}${runtime.variant}`,
  };
}
