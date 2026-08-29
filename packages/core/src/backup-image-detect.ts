/**
 * Which database a container image is — the MATCHING MECHANISM over the catalog's
 * image table, shared by the backup producers that act on it and the dashboard that
 * tells the operator what will happen.
 *
 * ## Why it is here
 *
 * There were two copies of the table. The producers each carried their own image
 * regex, and `PolicyEditor.tsx` carried a second set with a comment calling itself a
 * "display-only mirror … drift here is cosmetic".
 *
 * It is not cosmetic. That hint is the operator's only preview of what "Auto" will
 * do, and in [#611](https://github.com/oblien/openship/issues/611) it is exactly
 * what the reporter trusted: the dialog said *"Detected PostgreSQL — Auto backs it
 * up with pg_dump"*, the run silently used the volume fallback instead, and the
 * backup captured nothing. A dialog that promises one thing while the server does
 * another is not a cosmetic defect; it is the reason someone believes they have a
 * restore point.
 *
 * The table itself now lives one level up, in `./backup-catalog`, alongside the rest
 * of what a payload kind means — because the image match was never the only fact
 * about a kind that had been copied per layer. This module owns the REGEX RULE and
 * nothing else: given a reference, which catalog entry does it select.
 *
 * The remaining asymmetry is honest and unavoidable: the server also checks facts
 * the browser cannot know (whether the service has a live container, whether
 * credentials are discoverable), so the image match is a necessary condition for the
 * producer, never a sufficient one. `detectDbImage` answers "which database is this
 * image", and nothing more.
 *
 * ## Matching rule
 *
 * `^<name>(:|$)` — the repository name, then a tag separator or end of string. So
 * `postgres` and `postgres:16-alpine` match; `postgres-exporter:1` does not, and
 * neither does `someorg/postgres:16`, which is a different image that merely shares
 * a word.
 *
 * Plus `^<ns>/` for an entry that declares a `namespace`, which today is only `redis/`
 * (Redis Inc's own org, home of `redis/redis-stack`). `someorg/redis` still does not
 * match — the namespace is the OWNER, not the trailing word.
 *
 * The reference is normalized first (`normalizeImageRef`), so a registry-qualified
 * `docker.io/library/postgres:16` and a digest-pinned `postgres@sha256:…` match the
 * same entry as a bare `postgres:16`. The earlier boundary here said they did not,
 * on the grounds that stripping a prefix means deciding which prefixes are "the same
 * image". That decision is not ours to invent — Docker's reference grammar already
 * makes it, and `normalizeImageRef` follows it exactly, which is what keeps
 * `acme/mysql-proxy` unmatched.
 */

import { imageDetectableSpecs, type PayloadKind } from "./backup-catalog";

export interface DbImageMatch {
  /**
   * The kind this image selects under `auto`.
   *
   * Typed as the FULL `PayloadKind`, not a four-member `DbPayloadKind` subset. That
   * subset was a hand-maintained mirror of the producers' kinds — one more copy of
   * the same list, and one that would have had to be widened by hand the first time a
   * non-database kind became image-detectable. The catalog decides which kinds carry
   * an image matcher; this type does not need to re-state the answer.
   */
  payloadKind: PayloadKind;
  /** Product name for the UI hint ("PostgreSQL"). */
  label: string;
  /** The tool the operator will see named ("pg_dump"). */
  method: string;
}

const escapeRe = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `^name(:|$)` for each exact repository, plus `^ns/` for each namespace. Every regex
 * metacharacter in a name is escaped.
 */
function matcherFor(names: readonly string[], namespaces: readonly string[] = []): RegExp {
  const exact = `^(?:${names.map(escapeRe).join("|")})(?::|$)`;
  if (namespaces.length === 0) return new RegExp(exact, "i");
  return new RegExp(`${exact}|^(?:${namespaces.map(escapeRe).join("|")})/`, "i");
}

const MATCHERS: ReadonlyArray<{ re: RegExp; match: DbImageMatch }> = imageDetectableSpecs().map(
  (spec) => ({
    re: matcherFor(spec.images.names, spec.images.namespaces),
    match: { payloadKind: spec.kind, label: spec.label, method: spec.method },
  }),
);

/**
 * Strip the parts of a reference that say WHERE an image came from, leaving the
 * repository that says WHAT it is.
 *
 * The registry rule is Docker's own (`reference.splitDockerDomain`): the first path
 * component is a registry host if it contains a `.` or a `:`, or is exactly
 * `localhost`. Anything else is a Docker Hub namespace and is KEPT — which is what
 * keeps `acme/mysql-proxy` from ever reading as MySQL, and `ghcr.io/someorg/postgres`
 * from reading as PostgreSQL once `ghcr.io` is gone.
 *
 * `library` is then dropped from any non-final position: it is Docker Hub's reserved
 * namespace for official images, so `docker.io/library/postgres` IS `postgres` by
 * definition. Non-final rather than leading, because the public mirrors keep it behind
 * their own alias (`public.ecr.aws/docker/library/postgres`).
 *
 * A `@sha256:…` digest is removed first. It is not part of the repository, and left in
 * place it defeats the `(?::|$)` anchor — so a digest-pinned `postgres@sha256:…`, which
 * is what a compose file that pins by digest produces, read as "not a database" and
 * silently took a crash-consistent volume snapshot instead of a dump.
 */
export function normalizeImageRef(image: string): string {
  let ref = image.trim();
  const at = ref.indexOf("@");
  if (at > 0) ref = ref.slice(0, at);
  const parts = ref.split("/");
  const first = parts[0] ?? "";
  if (parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")) {
    parts.shift();
  }
  const library = parts.lastIndexOf("library");
  if (library >= 0 && library < parts.length - 1) parts.splice(0, library + 1);
  return parts.join("/");
}

/**
 * The database this image is, or null for anything else.
 *
 * A match is a NECESSARY condition for the matching producer, not a sufficient one —
 * see the module doc. Callers that need "what will actually run" must ask the server.
 */
export function detectDbImage(image?: string | null): DbImageMatch | null {
  const img = normalizeImageRef(image ?? "");
  if (!img) return null;
  for (const { re, match } of MATCHERS) {
    if (re.test(img)) return match;
  }
  return null;
}

/** True when `image` is the given database. The producers' `detects()` guard. */
export function isDbImage(image: string | null | undefined, kind: PayloadKind): boolean {
  return detectDbImage(image)?.payloadKind === kind;
}
