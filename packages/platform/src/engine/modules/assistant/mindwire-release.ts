/** The embedded Mindwire target reads this setting when it resolves its binary. */
export function configureMindwireReleaseBaseUrl(): string {
  return (process.env.MINDWIRE_RELEASE_BASE_URL ??=
    "https://github.com/oblien/mindwire-dist/releases/download");
}
