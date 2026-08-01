import { describe, expect, it } from "vitest";
import { DockerRuntime, ownsBuiltImage } from "../src/runtime/docker";

/**
 * `purge()` deletes a deployment row's image by TAG. That is only safe for tags
 * we minted ourselves, which are globally unique per build — one row owns one
 * tag. Every other tag on the box is shared, and deleting one by row is how you
 * strand something still using it:
 *
 *   - a docker-migration import reuses ONE mutable, registry-less tag across all
 *     of a compose project's sibling services. Untagging it for a single row
 *     (e.g. rolling back one failed service) leaves the siblings running from an
 *     image ID whose tag no longer resolves — and with no registry behind it, a
 *     later recreate fails with "repository does not exist", unrecoverable
 *     without a manual rebuild.
 *   - a registry tag (`postgres:17`) is shared with anything else using it, and
 *     deleting it achieves nothing since it re-pulls.
 *
 * The caller's keep-set answers "does another RETAINED release still need this
 * tag" (per project, from the DB). This answers the prior question: "is the tag
 * even ours to delete", which no keep-set can cover — it is per-project, while a
 * migrated tag can be shared across projects and carries no Openship label.
 */
describe("ownsBuiltImage", () => {
  it("claims only tags minted by our own builds", () => {
    // Matches `imageTag()`: openship/<slug>:<sessionId>.
    expect(ownsBuiltImage("openship/my-app:bld_123-svc_web")).toBe(true);
    expect(ownsBuiltImage("openship/build:bld_123")).toBe(true);
  });

  it("disclaims adopted and pulled tags", () => {
    // The docker-migration shape — one registry-less tag, many sibling services.
    expect(ownsBuiltImage("migration-360p-app:latest")).toBe(false);
    // Third-party pulls, including ones a migration records verbatim as imageRef.
    expect(ownsBuiltImage("postgres:17")).toBe(false);
    expect(ownsBuiltImage("redis:7-alpine")).toBe(false);
    expect(ownsBuiltImage("ghcr.io/acme/api:v1")).toBe(false);
    // Near-misses must not pass: a registry HOST that merely contains our name,
    // or a repo whose owner is called "openship" on some other registry.
    expect(ownsBuiltImage("registry.io/openship/app:1")).toBe(false);
    expect(ownsBuiltImage("notopenship/app:1")).toBe(false);
  });
});

describe("DockerRuntime.purge() image ownership", () => {
  /** Runtime with destroy/removeImage stubbed, recording what purge attempted. */
  async function runtimeSpy() {
    const runtime = await DockerRuntime.create();
    const calls = { destroyed: [] as string[], removed: [] as string[] };
    runtime.destroy = async (id: string) => {
      calls.destroyed.push(id);
    };
    runtime.removeImage = async (ref: string) => {
      calls.removed.push(ref);
    };
    return { runtime, calls };
  }

  it("removes an image we built", async () => {
    const { runtime, calls } = await runtimeSpy();

    await runtime.purge({
      id: "dep1",
      projectId: "proj1",
      imageRef: "openship/my-app:bld_1-svc_web",
      containerId: "app-id",
    } as any);

    expect(calls.removed).toEqual(["openship/my-app:bld_1-svc_web"]);
  });

  it("leaves a migration-adopted shared tag alone, but still destroys the container", async () => {
    const { runtime, calls } = await runtimeSpy();

    await runtime.purge({
      id: "dep1",
      projectId: "proj1",
      imageRef: "migration-360p-app:latest",
      containerId: "app-id",
    } as any);

    // The row's own container is still reclaimed — only the shared tag survives.
    expect(calls.destroyed).toEqual(["app-id"]);
    expect(calls.removed).toEqual([]);
  });

  it("leaves a pulled third-party tag alone", async () => {
    const { runtime, calls } = await runtimeSpy();

    await runtime.purge({
      id: "dep1",
      projectId: "proj1",
      imageRef: "postgres:17",
      containerId: "db-id",
    } as any);

    expect(calls.removed).toEqual([]);
  });

  it("is a no-op on the image when the row carries none", async () => {
    const { runtime, calls } = await runtimeSpy();

    await runtime.purge({
      id: "dep1",
      projectId: "proj1",
      imageRef: null,
      containerId: "app-id",
    } as any);

    expect(calls.destroyed).toEqual(["app-id"]);
    expect(calls.removed).toEqual([]);
  });
});
