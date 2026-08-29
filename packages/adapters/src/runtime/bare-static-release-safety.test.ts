/**
 * Two ways the bare static promote could damage what it was asked to publish.
 *
 * 1. It CONSUMED its source. `promoteBuildArtifact` was written for
 *    `.builds/<session>` staging dirs, so it `rm`s the source after the rsync and
 *    `mv`s it in the fallback. A static ROLLBACK hands back another deployment's
 *    retained RELEASE directory as the artifact, and the only guard —
 *    `artifactPath === releaseDir` — never matched, because the release id is the
 *    new deployment's. So rolling back to a release deleted it: the row went on
 *    advertising `artifact_retained_at` (and `pinned`, which purge exempts) while a
 *    second rollback needed a full rebuild, or was impossible for a release with no
 *    commit.
 *
 * 2. It published `.git`. When the doc root IS the release root (outputDirectory
 *    "." — what the plain `static` stack detects to) the served tree is the promoted
 *    source tree, which for a bare build is the git clone. `.git/config` on a
 *    token-cloned private repo holds `x-access-token:<TOKEN>`, readable over plain
 *    HTTP. The Docker sandbox path prunes exactly this; the bare twin never did.
 */

import { describe, expect, it } from "vitest";
import { BareRuntime, STATIC_RELEASE_BASE } from "./bare";
import { LocalExecutor } from "../system/executor";

const RELEASES = `${STATIC_RELEASE_BASE}/releases`;

/**
 * A fake host with a set of existing paths and a command log.
 *
 * Extends LocalExecutor because `execReliable` short-circuits to a plain `exec` for
 * one — so the promote's journaling does not have to be simulated.
 */
class FakeHost extends LocalExecutor {
  readonly commands: string[] = [];
  constructor(
    private paths: Set<string>,
    private readonly listings: Record<string, string[]> = {},
    private readonly unremovable: Set<string> = new Set(),
  ) {
    super();
  }

  override async exec(command: string): Promise<string> {
    this.commands.push(command);
    const ls = /^ls -A '([^']+)'/.exec(command);
    if (ls) return (this.listings[ls[1]] ?? []).join("\n");
    // The isEmptyDir probe: report a directory that has content.
    if (command.startsWith("if [ -d ")) {
      const dir = /'([^']+)'/.exec(command)?.[1] ?? "";
      const entries = this.listings[dir] ?? [...this.paths].filter((p) => p.startsWith(`${dir}/`));
      return entries.length > 0 ? "DIR\nsomething" : "DIR";
    }
    if (command.startsWith("rm -rf ")) {
      for (const m of command.matchAll(/'([^']+)'/g)) {
        if (this.unremovable.has(m[1])) continue;
        this.paths.delete(m[1]);
        for (const p of [...this.paths]) if (p.startsWith(`${m[1]}/`)) this.paths.delete(p);
      }
      return "";
    }
    if (command.includes("mkdir -p")) {
      for (const m of command.matchAll(/'([^']+)'/g)) this.paths.add(m[1]);
      return "";
    }
    if (command.startsWith("mv ")) {
      const [, from, to] = /^mv '([^']+)' '([^']+)'/.exec(command) ?? [];
      if (from && to) {
        this.paths.delete(from);
        this.paths.add(to);
      }
      return "";
    }
    if (command.startsWith("rsync ") || command.includes("cp -a ")) {
      const to = [...command.matchAll(/'([^']+)'/g)].at(-1)?.[1];
      if (to) this.paths.add(to.replace(/\/$/, ""));
      return "";
    }
    return "";
  }

  override async exists(path: string): Promise<boolean> {
    return this.paths.has(path);
  }

  override async rm(path: string): Promise<void> {
    this.commands.push(`rm ${path}`);
    if (this.unremovable.has(path)) return;
    this.paths.delete(path);
  }
}

function runtime(host: FakeHost): BareRuntime {
  return new BareRuntime({ workDir: STATIC_RELEASE_BASE, executor: host });
}

/** Every command that names this path, for the "was it destroyed" assertions. */
const touching = (host: FakeHost, path: string) =>
  host.commands.filter((c) => c.includes(path));

describe("a promote never destroys a source that is itself a release", () => {
  it("keeps the old release on the rsync branch", async () => {
    const old = `${RELEASES}/dep_old`;
    const host = new FakeHost(
      new Set([RELEASES, old, `${old}/index.html`, `${RELEASES}/dep_active`]),
      { [old]: ["index.html"], [`${RELEASES}/dep_new`]: ["index.html"] },
    );

    const out = await runtime(host).promoteStaticRelease({
      artifactPath: old,
      releaseId: "dep_new",
      previousReleaseId: "dep_active",
      outputDirectory: "",
      promote: true,
    });

    expect(out).toBe(`${RELEASES}/dep_new`);
    // The regression: `rm(artifactPath)` after the rsync.
    expect(await host.exists(old)).toBe(true);
    expect(touching(host, old).filter((c) => c.startsWith("rm "))).toEqual([]);
  });

  it("COPIES instead of moving when there is no previous release to link against", async () => {
    // The fallback branch was worse than the rsync one: `mv` renames the retained
    // release away outright.
    const old = `${RELEASES}/dep_old`;
    const host = new FakeHost(new Set([RELEASES, old, `${old}/index.html`]), {
      [old]: ["index.html"],
      [`${RELEASES}/dep_new`]: ["index.html"],
    });

    const out = await runtime(host).promoteStaticRelease({
      artifactPath: old,
      releaseId: "dep_new",
      outputDirectory: "",
      promote: true,
    });

    expect(out).toBe(`${RELEASES}/dep_new`);
    expect(await host.exists(old)).toBe(true);
    expect(host.commands.some((c) => c.startsWith("mv "))).toBe(false);
    expect(host.commands.some((c) => c.includes("cp -a "))).toBe(true);
  });

  it("still consumes an ordinary .builds staging dir", async () => {
    // The behaviour that must NOT change: a staging dir is disposable, and leaving
    // it behind would accumulate a full copy of every build on disk.
    const staged = `${STATIC_RELEASE_BASE}/.builds/build_1`;
    const host = new FakeHost(new Set([staged, `${staged}/index.html`, `${RELEASES}/dep_prev`]), {
      [staged]: ["index.html"],
      [`${RELEASES}/dep_new`]: ["index.html"],
    });

    await runtime(host).promoteStaticRelease({
      artifactPath: staged,
      releaseId: "dep_new",
      previousReleaseId: "dep_prev",
      outputDirectory: "",
      promote: true,
    });

    expect(await host.exists(staged)).toBe(false);
  });
});

describe("a doc root that IS the release root is pruned of build inputs", () => {
  it("removes .git before publishing", async () => {
    const release = `${RELEASES}/dep_new`;
    const host = new FakeHost(
      new Set([RELEASES, release, `${release}/.git`, `${release}/index.html`]),
      { [release]: [".git", "index.html", "Dockerfile.openship", ".dockerignore"] },
    );

    await runtime(host).promoteStaticRelease({
      artifactPath: release,
      releaseId: "dep_new",
      outputDirectory: ".",
      // promote:false — the artifact already IS the release dir, which is the shape
      // that makes staticRoot === workDir and so the shape that leaked.
      promote: false,
    });

    expect(await host.exists(`${release}/.git`)).toBe(false);
    const rm = host.commands.find((c) => c.startsWith("rm -rf ") && c.includes(".git"));
    expect(rm).toBeTruthy();
    // The same predicate the Docker sandbox uses, so all four go, not just .git.
    expect(rm).toContain("Dockerfile.openship");
    expect(rm).toContain(".dockerignore");
    // ...and real content is untouched.
    expect(await host.exists(`${release}/index.html`)).toBe(true);
  });

  it("REFUSES to publish when .git cannot be removed", async () => {
    // A failed prune is a published access token, so it fails the deploy rather
    // than proceeding. Verified by re-stat, not by the rm's exit status.
    const release = `${RELEASES}/dep_new`;
    const host = new FakeHost(
      new Set([RELEASES, release, `${release}/.git`, `${release}/index.html`]),
      { [release]: [".git", "index.html"] },
      new Set([`${release}/.git`]),
    );

    await expect(
      runtime(host).promoteStaticRelease({
        artifactPath: release,
        releaseId: "dep_new",
        outputDirectory: ".",
        promote: false,
      }),
    ).rejects.toThrow(/Refusing to publish/);
  });

  it("leaves a nested output directory alone", async () => {
    // Only the release-root case can contain build inputs; `dist/` is build OUTPUT,
    // and a prune there could delete a legitimately-named file the site serves.
    const release = `${RELEASES}/dep_new`;
    const host = new FakeHost(
      new Set([RELEASES, release, `${release}/dist`, `${release}/.git`, `${release}/dist/index.html`]),
      { [`${release}/dist`]: ["index.html"] },
    );

    await runtime(host).promoteStaticRelease({
      artifactPath: release,
      releaseId: "dep_new",
      outputDirectory: "dist",
      promote: false,
    });

    // Not served, so not our business to delete here.
    expect(await host.exists(`${release}/.git`)).toBe(true);
  });
});
