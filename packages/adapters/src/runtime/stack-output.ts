/**
 * Stack output preparation — the pipeline-agnostic hook for: "did this stack's
 * build emit a self-contained bundle we can ship wholesale (traced deps, no
 * on-target install)?"
 *
 * Every runtime that ships a local build (bare/server, cloud, …) consults this
 * instead of hardcoding per-stack branches. Add support for a stack by
 * registering a preparer here — no runtime edits needed. The per-stack
 * detection logic (e.g. Next's `.next/standalone` + static/public nesting)
 * lives in its own module; this is just the registry + generic entry points.
 */

import { join, posix as pathPosix } from "node:path";
import type { StackId } from "@repo/core";
import { prepareNextStandalone, type NextStandalonePlan } from "./nextjs-standalone";

/** A self-contained build output: ship `bundleDir` as-is; run `startCommand`. */
export type StackOutputPlan = NextStandalonePlan;

/** Given the built project dir, return a shippable bundle — or null (→ host mode). */
export type StackOutputPreparer = (projectDir: string) => Promise<StackOutputPlan | null>;

/**
 * Per-stack self-contained-output preparers. A stack appears here only when its
 * build can emit a wholesale-shippable bundle. Slot new stacks in the same way:
 *   nextjs → next.config `output: 'standalone'` → `.next/standalone`
 *   (nuxt/nitro `.output`, sveltekit adapter-node, … register alongside)
 */
export const STACK_OUTPUT_PREPARERS: Partial<Record<StackId, StackOutputPreparer>> = {
  nextjs: prepareNextStandalone,
};

/** Run the stack's preparer if one is registered; null otherwise. */
export async function prepareStackOutput(
  stack: string,
  projectDir: string,
): Promise<StackOutputPlan | null> {
  const prepare = STACK_OUTPUT_PREPARERS[stack as StackId];
  return prepare ? prepare(projectDir) : null;
}

/**
 * Resolve the project directory inside a local build dir, honoring a
 * (possibly slash-wrapped) `rootDirectory`. Mirrors `resolveBuildDirectory`
 * in build-pipeline.ts. Generic build-dir helper — not stack-specific.
 */
export function resolveProjectDir(buildDir: string, rootDirectory?: string): string {
  const normalized = rootDirectory?.trim().replace(/^\/+|\/+$/g, "");
  return normalized ? join(buildDir, normalized) : buildDir;
}

/**
 * Resolve a static deploy's output directory to a concrete path under `base`.
 *
 * Shared by both static-deploy paths so their "." / traversal / absolute rules
 * never drift: self-hosted (the result becomes OpenResty's `root <dir>;`) and
 * cloud Pages (the result becomes the export `path` inside the build VM).
 *
 * Unlike {@link resolveProjectDir}, this CONFINES the result — the value is
 * served / exported as a document root, so an absolute path (e.g. "/etc") or a
 * `../`-traversal would point it at the host/VM filesystem (TLS keys, other
 * tenants, /etc/passwd): arbitrary file disclosure over the app's public
 * domain. Reject absolute, confine relative. "." and "" mean "serve `base`".
 */
export function resolveStaticOutputPath(base: string, outputDirectory: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  if (!outputDirectory || outputDirectory === ".") {
    return normalizedBase;
  }
  if (outputDirectory.startsWith("/")) {
    throw new Error(
      `Invalid outputDirectory "${outputDirectory}": must be relative to the project (absolute paths are not allowed).`,
    );
  }
  const resolved = pathPosix.normalize(pathPosix.join(normalizedBase, outputDirectory));
  if (resolved !== normalizedBase && !resolved.startsWith(`${normalizedBase}/`)) {
    throw new Error(
      `Invalid outputDirectory "${outputDirectory}": escapes the deployment directory.`,
    );
  }
  return resolved;
}

/**
 * The directory a ROUTED PATH serves from, beneath a static deploy's doc root:
 * `/` serves the root itself, `/docs` serves `<root>/docs`.
 *
 * THE definition of that rule. It decides whether a static site 404s, and it had
 * three independent copies — the deploy-time route registration, the live route
 * re-apply, and the post-deploy output probe. Any drift between them means the
 * vhost is pointed at one directory while the check that audits it looks at
 * another, so a real 404 reads as healthy (or a healthy site as broken).
 *
 * Confines the result for the same reason {@link resolveStaticOutputPath} does:
 * `targetPath` is operator input from the Domains tab, and a `../` in it would
 * aim a public document root at the host filesystem. The nginx renderer rejects
 * traversal too — this is the earlier of the two gates, not a replacement.
 */
export function resolveServedStaticPath(staticRoot: string, routedPath: string): string {
  const root = staticRoot.replace(/\/+$/, "");
  const relative = routedPath.replace(/^\/+/, "");
  if (!relative) return root;
  const resolved = pathPosix.normalize(pathPosix.join(root, relative));
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Invalid route path "${routedPath}": escapes the deployment's static root.`);
  }
  return resolved;
}
