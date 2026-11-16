/** Stable catalog identifiers keep the public English source readable at call sites.
 * @param {string} source
 */
export function messageKey(source) {
  let hash = 2166136261;
  // Cached release text may still contain the older display casing.
  for (const character of source
    .replace(/\bOpenship\b/g, "OpenShip")
    .trim()
    .replace(/\s+/g, " ")) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `m${(hash >>> 0).toString(36)}`;
}
