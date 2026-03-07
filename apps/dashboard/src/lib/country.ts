/**
 * Country / flag utilities.
 *
 * Uses the `flagcdn.com` CDN to serve flag images by ISO 3166-1 alpha-2 code.
 */

/** Returns a URL for the country flag image for the given ISO country code. */
export function getCountryFlagUrl(
  countryCode: string,
  size: "16" | "24" | "32" | "48" | "64" | "128" = "24"
): string {
  if (!countryCode) return "";
  return `https://flagcdn.com/${size}x${Math.floor(Number(size) * 0.75)}/${countryCode.toLowerCase()}.png`;
}

/** Maps a country code to a human-readable name via Intl API. */
export function getCountryName(countryCode: string, locale = "en"): string {
  if (!countryCode) return "Unknown";
  try {
    const regionNames = new Intl.DisplayNames([locale], { type: "region" });
    return regionNames.of(countryCode.toUpperCase()) ?? countryCode;
  } catch {
    return countryCode;
  }
}
