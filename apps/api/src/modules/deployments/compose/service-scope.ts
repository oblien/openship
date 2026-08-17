/**
 * What a compose deploy is allowed to do with one service — the scope decision the
 * deploy loop makes before it touches anything.
 *
 * Pure and separate from `deploy.service.ts` so it can be tested without importing
 * that module's whole runtime/routing graph (same reason `composite-route.ts` sits
 * beside it rather than inside it).
 */

/** `reason` recorded for a service a scoped deploy left alone. See the schema's `reason` doc. */
export const OUT_OF_SCOPE_SKIP_REASON = "out-of-scope";

/**
 * The image this deploy intends for a service, in priority order:
 * freshly built → the service row's configured (pulled/external) image → the previous
 * deployment's image, which is what lets an env-only REFRESH (recreated but not rebuilt)
 * and a revive of a dead container come back without a build.
 *
 * `""` means nothing is available — the service cannot be brought up at all. Callers
 * distinguish "in scope and genuinely broken" (a failure) from "out of scope with nothing
 * to do" (a skip) with `isUntargetedAndUndeployable` below.
 */
export function resolveDeployImage(args: {
  builtImage?: string;
  rowImage?: string | null;
  previousImageRef?: string | null;
}): string {
  return args.builtImage ?? args.rowImage ?? args.previousImageRef ?? "";
}

/**
 * True when this deploy was scoped to a subset that excludes this service AND there is no
 * image to bring it up with — so there is nothing this deploy could do for it even if it
 * wanted to.
 *
 * Such a service must be SKIPPED, not failed. Failing it is what made `--service-ids`
 * unusable on a partially provisioned project (#585): the untargeted sibling's `failure`
 * row rolled the whole deployment up to `partial_failure` ("Action Required"), and marking
 * it unavailable then blocked any TARGETED service that `depends_on` it — so the one
 * service the operator asked for never deployed.
 *
 * Deliberately narrow on both axes:
 *   - A FULL deploy (no subset) targets everything, so a missing image there is a real
 *     failure and stays one.
 *   - An untargeted service that DOES have an image is still deployed (revived) when its
 *     container turns out to be gone — a partial deploy self-heals a dead sibling, and
 *     that behaviour is unchanged.
 */
export function isUntargetedAndUndeployable(args: {
  serviceId: string;
  /** The resolved image from `resolveDeployImage` — `""` when none is available. */
  image: string;
  /** Undefined = full deploy (every enabled service is targeted). */
  targetServiceIds?: Set<string>;
}): boolean {
  // An EMPTY set is treated as a full deploy, not as "nothing is targeted". Callers
  // normalize an empty subset to undefined (compose/pipeline.ts) and one of them refuses
  // it outright (build.service.ts's refresh path, "Nothing to refresh"), so an empty set
  // arriving here is a bug upstream — and the failure mode of the literal reading is to
  // quietly skip every service in the project.
  if (!args.targetServiceIds || args.targetServiceIds.size === 0) return false;
  if (args.targetServiceIds.has(args.serviceId)) return false;
  return !args.image;
}
