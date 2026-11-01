/**
 * The `deployment.container_id` / `image_ref` sentinel, and the one predicate for
 * "is this a reference I can hand to a runtime".
 *
 * A leaf module on purpose: the sentinel is read on the write path (compose
 * deploy, reconcile), the read path (logs, container info, routing upstreams) and
 * in rollback planning, and every open-coded `=== "compose"` was a place that
 * could forget.
 */

/** Stored in `deployment.container_id` / `image_ref` when a release has no single
 *  primary container/image. A marker, never a real Docker reference — treating it
 *  as one is what made compose rollback try `createContainer({ Image: "compose" })`
 *  and made a project pause report success having stopped nothing. */
export const COMPOSE_SENTINEL = "compose";

/** The reference, trimmed, when it names something a runtime can actually act on
 *  — else null. Trims because these come from stored columns and a whitespace-only
 *  value is as unusable as an empty one. */
export function usableRef(ref: string | null | undefined): string | null {
  const trimmed = ref?.trim();
  if (!trimmed || trimmed === COMPOSE_SENTINEL) return null;
  return trimmed;
}

/** `usableRef` as a type guard, for the call sites that only need the question
 *  answered and already hold a clean value. */
export function isRealContainerRef(ref: string | null | undefined): ref is string {
  return usableRef(ref) !== null;
}

/**
 * Is this ref a filesystem DIRECTORY a runtime produced, rather than a Docker
 * image or container?
 *
 * A static deploy stores a HOST PATH in the very columns that otherwise hold
 * image tags and container ids: `service_deployment.image_ref` for a compose
 * static sub-app, `deployment.image_ref` / `deployment.container_id` for a
 * single-app static. Nothing in the column's type says which it is, so every
 * consumer that picks a runtime VERB from one of those columns has to ask this
 * question — and the ones that didn't picked `removeImage` for a directory, which
 * is issue #640.
 *
 * The test is a LEADING slash, not `includes("/")`: an image tag legitimately
 * contains slashes (`openship/my-app:bld_1`, `ghcr.io/org/img`) but can never
 * start with one, and every artifact path this codebase writes is absolute.
 */
export function isArtifactRef(ref: string | null | undefined): boolean {
  const usable = usableRef(ref);
  return usable !== null && usable.startsWith("/");
}
