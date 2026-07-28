/**
 * Compatibility re-export of the release-dist resolver.
 *
 * This file and `release-resolver.ts` were BYTE-IDENTICAL copies of the same
 * ~215-line module, and different callers imported from each (catalog-source
 * from here; build.service, project-crud, openship-dist and webmail from
 * release-resolver). Two copies of a resolver that downloads and sha-verifies
 * release tarballs is exactly the kind of thing that drifts silently — a fix
 * applied to one and not the other reads as "fixed" while half the callers keep
 * the old behaviour.
 *
 * `release-resolver.ts` is now the single implementation; this stays as a
 * re-export so existing imports (and `test/lib/release-dist.test.ts`) keep
 * working. Prefer importing from `release-resolver` in new code.
 */

export {
  apiRootPath,
  readApiVersion,
  ReleaseDistMissingError,
  resolveReleaseDist,
  resolveReleaseDistOrNull,
  fetchLatestRelease,
  resolveLatestReleaseTag,
  resolveLatestVersion,
  type ReleaseDistSpec,
  type ReleaseDistResult,
} from "./release-resolver";
