# Vendored GeoLite2-Country database

`GeoLite2-Country.mmdb` is our own copy of the MaxMind GeoLite2 country
database, used by `apps/api/src/lib/geo-ip.ts` to resolve a server's IP to a
country flag in the Servers list.

**Why it's committed here:** production reads this shipped copy — the running
server never depends on a third-party mirror. It's copied into `dist/assets`
at build (`scripts/copy-assets.mjs`) and resolved relative to the bundle.

**Updating:** normal release preparation and continuation run `bun run update:geoip`
before committing and tagging. Every artifact is built from that pinned snapshot,
so release retries can still reuse artifacts whose source inputs match. A download
must parse as GeoLite2-Country and be at most 14 days old before replacing the copy.
The release gate checks the tagged snapshot again before publication, including
manual Docker publishing. Direct tag pushes cannot publish a stale snapshot.

Run `bun run update:geoip` to refresh locally or append `--check` to validate the
existing copy without downloading. The **GeoIP database** GitHub Actions workflow
also supports manual dispatch. Its default refresh mode uploads the validated
MMDB and a JSON receipt containing the build date and SHA-256, without creating a
release or changing the branch. Use a source commit containing the refreshed copy
before a manual Docker publish. The workflow's reusable mode validates source
bytes and does not replace tagged inputs during a build.

The updater is the only place an upstream mirror is referenced, and runs at
maintainer/CI time. Override it with `GEOIP_UPSTREAM_URL` to use another source,
such as MaxMind directly.

**Runtime overrides:** `OPENSHIP_GEOIP_DB` (explicit path) and
`OPENSHIP_GEOIP_URL` (download fallback, defaults to our repo).

Data © MaxMind, GeoLite2 — see https://www.maxmind.com. Attribution required.
