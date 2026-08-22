import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the environments list is written, and why every environment mutation
 * must also drop the project caches (#657).
 *
 * The `environments` state in ProjectSettingsContext has TWO writers: the
 * effect that re-seeds it from the bundled /info payload whenever
 * `projectInfo` changes, and `refreshEnvironments()` which patches it from the
 * dedicated list endpoint. A create/delete that only patches the second one
 * loses: the module-level infoCache still holds the OLD bundle, so the next
 * `projectInfo` emit re-runs the effect and writes the stale list back over
 * the fresh one — the new environment vanishes (or the deleted one lingers)
 * until a hard reload.
 *
 * The list ships inside EVERY environment's /info payload, so siblings'
 * cached bundles go stale too — hence invalidating known sibling ids, not
 * just the current one.
 *
 * The fix is wiring, not logic — invisible to a typecheck and to a static
 * render, and there is no jsdom harness for this provider — so like
 * advanced-migration-session.test.ts it is pinned here in source.
 */
const here = dirname(fileURLToPath(import.meta.url));
const context = readFileSync(join(here, "./ProjectSettingsContext.tsx"), "utf8");
const page = readFileSync(
  join(here, "../app/(dashboard)/projects/[id]/[[...slug]]/page.tsx"),
  "utf8",
);

describe("creating an environment survives the next projectInfo emit", () => {
  // Anchored on the return, not a byte count: everything up to it is the
  // mutation's success path, and a comment added above cannot slide it.
  const createEnvironment = context.slice(context.indexOf("const createEnvironment = useCallback"));
  const body = createEnvironment.slice(0, createEnvironment.indexOf("return response.data"));

  it("drops the stale info cache instead of only patching the derived copy", () => {
    expect(body).toContain("invalidateProjectCaches(id)");
    // Sibling bundles carry the shared list too; dropping only the current id
    // leaves every OTHER cached page missing the new entry until a reload.
    expect(body).toContain("eid !== String(id)");
  });

  it("invalidates BEFORE refreshing, so no emit can race the stale bundle back in", () => {
    // Order is the bug: refreshEnvironments' correct patch only holds until
    // the cached bundle is re-emitted. Invalidation has to land first.
    expect(body.indexOf("invalidateProjectCaches(id)")).toBeLessThan(
      body.indexOf("await refreshEnvironments()"),
    );
  });
});

describe("deleting an environment leaves no dead entry behind", () => {
  const handler = page.slice(
    page.indexOf("const handleDeleteProject"),
    page.indexOf("const renderTabContent"),
  );

  // Pinned on the helper's DEFINITION: proves the teardown actually drops
  // caches rather than that a function by that name exists.
  const helper = handler.slice(
    handler.indexOf("const invalidateAfterTeardown = "),
    handler.indexOf("\n    try {"),
  );

  it("invalidates every known id — the deleted one and its stale siblings", () => {
    expect(helper).toContain("invalidateProjectCaches(eid)");
    expect(helper).toContain("for (const env of environments ?? [])");
  });

  it("runs on ALL THREE success exits", () => {
    // Two inside try (full ok + unrecoverable-partial) and the 404 in catch:
    // another tab already deleted the row, so this tab's caches are
    // guaranteed stale there. Real failures (409 active-work,
    // deletion-in-progress, teardown-failed) must NOT invalidate.
    expect(handler.split("invalidateAfterTeardown();").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("the cross-tab 404 exit invalidates before navigating home", () => {
    const notFoundExit = handler.slice(
      handler.indexOf("// 404: someone else already deleted"),
      handler.indexOf("showToast(getApiErrorMessage(err"),
    );
    expect(notFoundExit).toContain("invalidateAfterTeardown();");
    expect(notFoundExit.indexOf("invalidateAfterTeardown();")).toBeLessThan(
      notFoundExit.indexOf('router.push("/")'),
    );
  });
});
