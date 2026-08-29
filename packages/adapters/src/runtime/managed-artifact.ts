/**
 * Removing a DIRECTORY that a runtime produced — the one place an `rm -rf` of an
 * Openship-managed path is authorized, bounded and verified.
 *
 * Both runtimes' `destroy()` accept an absolute-path ref (a static doc-root, a
 * bare release dir, a build dir) because the columns they read from — a
 * deployment's `container_id`, a service_deployment's `image_ref` — legitimately
 * hold one. That makes `destroy()` a function that `rm -rf`s a value read out of
 * the database, reached from a dozen independent callers. The confinement
 * therefore belongs HERE, at the operation, not at each classification site: a
 * guard at one caller protects exactly that caller, while the invariant "we only
 * ever remove inside our own tree" is a property of the removal itself.
 *
 * Same reasoning, and the same prefix-on-a-BOUNDARY idiom, as
 * `assertValidStaticRoot` in infra/nginx.ts, which confines the vhost `root` it
 * emits rather than trusting every route planner upstream.
 */

import { sq } from "../system/local-shell";
import type { CommandExecutor } from "../types";

/**
 * Every directory tree an Openship runtime may create and therefore may remove:
 * `BareRuntime`'s default workDir, `STATIC_RELEASE_BASE` under it, and the
 * `.builds`/`releases` subdirs of both.
 *
 * Deliberately a runtime-layer constant rather than an import of
 * `MANAGED_STATIC_BASE` from infra/nginx.ts — runtime/ does not depend on infra/,
 * and the two answer different questions (what we may SERVE vs what we may
 * REMOVE) even though today they name the same tree.
 */
export const MANAGED_ARTIFACT_BASE = "/opt/openship";

/** Paths that are containers for artifacts, never artifacts themselves. Removing
 *  one would take out every project's output plus the bind mount the edge reads
 *  through, so a ref that lands exactly on one is a bug upstream, not a target. */
const PROTECTED_ROOTS = new Set([
  MANAGED_ARTIFACT_BASE,
  // BareRuntime's own layout (workDir = MANAGED_ARTIFACT_BASE): releases/<depId>,
  // .builds/<sessionId>. The parents hold every project's releases at once.
  `${MANAGED_ARTIFACT_BASE}/releases`,
  `${MANAGED_ARTIFACT_BASE}/.builds`,
  // The static tree, whose parent is ALSO the one directory bind-mounted into the
  // edge container — removing it stops the box serving every static site it hosts.
  `${MANAGED_ARTIFACT_BASE}/static`,
  `${MANAGED_ARTIFACT_BASE}/static/releases`,
  `${MANAGED_ARTIFACT_BASE}/static/.builds`,
]);

/** Trailing slashes off, so `/opt/openship/static/` and `/opt/openship/static`
 *  are the same protected root and a boundary test can't be fooled by one. */
function canonical(ref: string): string {
  const trimmed = ref.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/**
 * Throw unless `ref` names a directory this codebase created under
 * {@link MANAGED_ARTIFACT_BASE}.
 *
 * The prefix test is on a path BOUNDARY: `/opt/openshipmore` is not inside
 * `/opt/openship`. Same rule as the proxy importer's root matching.
 */
export function assertManagedArtifactPath(ref: string): void {
  const target = canonical(ref);
  if (!target.startsWith("/") || target.includes("..")) {
    throw new Error(
      `Refusing to remove "${ref}": an artifact path must be absolute and free of "..".`,
    );
  }
  if (PROTECTED_ROOTS.has(target)) {
    throw new Error(
      `Refusing to remove "${ref}": that is a shared parent directory, not one deployment's output.`,
    );
  }
  if (target !== MANAGED_ARTIFACT_BASE && !target.startsWith(`${MANAGED_ARTIFACT_BASE}/`)) {
    throw new Error(
      `Refusing to remove "${ref}": outside ${MANAGED_ARTIFACT_BASE}. Openship removes only ` +
        `directories it created (release dirs, static doc-roots, build dirs).`,
    );
  }
}

/**
 * Remove a managed directory and PROVE it is gone.
 *
 * Contract, matching `destroy()`'s container branch exactly: already-absent is
 * SUCCESS (both `rm -rf` and `fs.rm(force)` exit 0 on a missing path), and
 * anything else — EACCES on a root-owned tree, a read-only mount, EBUSY —
 * THROWS. The previous `.catch(() => {})` made this operation incapable of
 * failing, which is the shape that reports "cleanup: 5/5 ok" for a directory
 * still on disk. The post-check is what closes the remaining gap: `rm -rf`
 * itself exits 0 on some partial failures.
 */
export async function removeManagedArtifact(
  executor: CommandExecutor | null,
  ref: string,
): Promise<void> {
  assertManagedArtifactPath(ref);
  const target = canonical(ref);

  if (executor) {
    await executor.exec(`rm -rf ${sq(target)}`);
    if (await executor.exists(target)) {
      throw new Error(`Failed to remove ${target}: still present after rm -rf.`);
    }
    return;
  }

  const { rm, access } = await import("node:fs/promises");
  await rm(target, { recursive: true, force: true });
  const stillThere = await access(target).then(
    () => true,
    () => false,
  );
  if (stillThere) throw new Error(`Failed to remove ${target}: still present after rm.`);
}

/**
 * An absolute-path ref is a filesystem DIRECTORY a runtime produced, never a
 * Docker image or container. Image tags contain "/" but never START with one, and
 * a container id is hex.
 *
 * The adapters-side twin of the API's `isArtifactRef`; both exist because both
 * layers read the same ambiguous columns and neither can import the other.
 */
export function isArtifactPathRef(ref: string): boolean {
  return ref.startsWith("/");
}
