import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `evaluateDrift` decides "is an update available?" from a POSSIBLY CACHED upstream
 * state and the project's LIVE deployed state. The split exists because of a real
 * bug: the cache used to store both halves, so a row polled mid-window kept
 * advertising "update available 1f73d58 → 282619c" for a project whose own
 * deployment list showed 282619c shipped days earlier. Seven code paths move
 * `activeDeploymentId`; only one ever refreshed the cache.
 *
 * So what these pin is the invariant that replaced those seven hooks:
 *
 *   1. The deployed side is READ, never remembered. The same cached upstream must
 *      produce different verdicts as the active deployment moves — that's what
 *      makes the Issues feed agree with the project page by construction.
 *   2. A cached upstream is only answerable for the SOURCE it was polled from.
 *      Repoint the branch, the release source, or a service's tag and the row
 *      becomes a miss (reported as "no update"), not a comparison against the
 *      wrong question's answer. This is why no code path needs to invalidate.
 *   3. Fail-soft everywhere. An unresolvable HEAD/digest is never evidence of
 *      drift — we don't show a nudge the operator can disprove.
 *   4. In-flight suppression is live, so pressing Update quiets the nudge at once
 *      instead of waiting for the next scan.
 */

const deploymentRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  findInProgressByCommit: vi.fn(),
  findInProgressByReleaseVersion: vi.fn(),
}));
const serviceRepo = vi.hoisted(() => ({ listByProject: vi.fn(), listByDeployment: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: { ...actual.repos, deployment: deploymentRepo, service: serviceRepo },
  };
});

import {
  commitSourceKey,
  evaluateDrift,
  releaseSourceKey,
  type UpstreamDrift,
} from "../../../src/modules/projects/project-crud.service";
import type { Project } from "@repo/db";

const SHIPPED = "13140747f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6";
const NEWER = "282619c7aabbccddeeff00112233445566778899";

const gitProject = (over: Partial<Project> = {}) =>
  ({
    id: "proj_1",
    organizationId: "org_1",
    name: "openship",
    gitProvider: "github",
    gitOwner: "oblien",
    gitRepo: "openship",
    gitBranch: "main",
    appTemplateId: null,
    releaseSource: null,
    activeDeploymentId: "dep_live",
    ...over,
  }) as Project;

/** A commit upstream polled from the project's current source. */
const commitUpstream = (p: Project, latestSha: string | null): UpstreamDrift => ({
  supported: true,
  mode: "commit",
  key: commitSourceKey(p),
  latestSha,
  latestMessage: "support force on release",
});

beforeEach(() => {
  for (const fn of Object.values({ ...deploymentRepo, ...serviceRepo })) fn.mockReset();
  deploymentRepo.findInProgressByCommit.mockResolvedValue(undefined);
  deploymentRepo.findInProgressByReleaseVersion.mockResolvedValue(undefined);
  serviceRepo.listByProject.mockResolvedValue([]);
  serviceRepo.listByDeployment.mockResolvedValue([]);
});

describe("commit drift — the deployed side is live", () => {
  it("reports no update once the deployment shipped the cached HEAD", async () => {
    // The exact reported case: the cached upstream is old (polled while an older
    // release was live), but the project has since deployed that very commit.
    const p = gitProject();
    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", commitSha: NEWER });

    const status = await evaluateDrift(p, commitUpstream(p, NEWER));

    expect(status).toMatchObject({ supported: true, mode: "commit", behind: false });
  });

  it("gives opposite verdicts for the same cached upstream as the active deployment moves", async () => {
    // Nothing about the cache changes between these two calls — only which
    // deployment is active. If the deployed side were ever cached, this is the
    // assertion that would fail, and the operator would see the stale banner.
    const p = gitProject();
    const upstream = commitUpstream(p, NEWER);

    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", commitSha: SHIPPED });
    const before = await evaluateDrift(p, upstream);

    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", commitSha: NEWER });
    const after = await evaluateDrift(p, upstream);

    expect(before).toMatchObject({ behind: true, deployedSha: SHIPPED });
    expect(after).toMatchObject({ behind: false, deployedSha: NEWER });
  });

  it("suppresses the nudge while the newest commit is already deploying", async () => {
    const p = gitProject();
    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", commitSha: SHIPPED });
    deploymentRepo.findInProgressByCommit.mockResolvedValue({ id: "dep_building" });

    const status = await evaluateDrift(p, commitUpstream(p, NEWER));

    expect(status).toMatchObject({ behind: true, latestInProgress: true });
    expect(deploymentRepo.findInProgressByCommit).toHaveBeenCalledWith("proj_1", NEWER);
  });

  it("claims nothing when the remote HEAD could not be resolved", async () => {
    const p = gitProject();
    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", commitSha: SHIPPED });

    const status = await evaluateDrift(p, commitUpstream(p, null));

    expect(status).toMatchObject({ behind: false, latestSha: null });
  });

  it("claims nothing when the project has never deployed", async () => {
    const p = gitProject({ activeDeploymentId: null });

    const status = await evaluateDrift(p, commitUpstream(p, NEWER));

    expect(status).toMatchObject({ behind: false, deployedSha: null });
    expect(deploymentRepo.findById).not.toHaveBeenCalled();
  });
});

describe("cache keys — a repointed source is a miss, not stale drift", () => {
  it("ignores a HEAD polled for a different branch", async () => {
    const polledOn = gitProject({ gitBranch: "main" });
    const upstream = commitUpstream(polledOn, NEWER);
    // Operator repoints the project at a release branch. `main`'s HEAD says
    // nothing about it, and no invalidation call ran — the key mismatch is what
    // keeps this honest.
    const now = gitProject({ gitBranch: "release/0.6" });
    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", commitSha: SHIPPED });

    const status = await evaluateDrift(now, upstream);

    expect(status).toMatchObject({ behind: false, latestSha: null, branch: "release/0.6" });
    // …and no half-truth rides along: the message belonged to the other branch.
    expect(status).toMatchObject({ latestMessage: null });
  });

  it("ignores a HEAD polled for a different repo", async () => {
    const upstream = commitUpstream(gitProject(), NEWER);
    const now = gitProject({ gitRepo: "openship-fork" });
    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", commitSha: SHIPPED });

    expect(await evaluateDrift(now, upstream)).toMatchObject({ behind: false, latestSha: null });
  });

  it("ignores a version polled from a different release source", async () => {
    const polledOn = gitProject({
      gitProvider: "release",
      releaseSource: { mode: "github", repo: "oblien/openship" } as never,
    });
    const upstream: UpstreamDrift = {
      supported: true,
      mode: "release",
      key: releaseSourceKey(polledOn),
      latestVersion: "0.6.0",
      pinned: false,
    };
    const now = gitProject({
      gitProvider: "release",
      releaseSource: { mode: "github", repo: "someone/else" } as never,
    });
    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", releaseVersion: "0.5.0" });

    expect(await evaluateDrift(now, upstream)).toMatchObject({
      behind: false,
      latestVersion: null,
    });
  });

  it("still reports real release drift when the source matches", async () => {
    const p = gitProject({
      gitProvider: "release",
      releaseSource: { mode: "github", repo: "oblien/openship" } as never,
    });
    deploymentRepo.findById.mockResolvedValue({ id: "dep_live", releaseVersion: "0.5.0" });

    const status = await evaluateDrift(p, {
      supported: true,
      mode: "release",
      key: releaseSourceKey(p),
      latestVersion: "0.6.0",
      pinned: false,
    });

    expect(status).toMatchObject({
      behind: true,
      currentVersion: "0.5.0",
      latestVersion: "0.6.0",
    });
  });

  it("drops a cached row whose project changed drift shape entirely", async () => {
    // Repo removed (now an image-only app): a commit upstream can't be evaluated.
    const now = gitProject({ gitOwner: null, gitRepo: null });
    const upstream = commitUpstream(gitProject(), NEWER);

    expect(await evaluateDrift(now, upstream)).toEqual({ supported: false });
  });
});

describe("image drift — digests keyed by the ref they were polled for", () => {
  const imageProject = () => gitProject({ gitOwner: null, gitRepo: null });
  const svc = (over: Record<string, unknown> = {}) => ({
    id: "svc_1",
    name: "n8n",
    image: "n8nio/n8n:1.2",
    build: null,
    enabled: true,
    ...over,
  });

  it("reports drift when the tag resolves to a new digest", async () => {
    serviceRepo.listByProject.mockResolvedValue([svc()]);
    serviceRepo.listByDeployment.mockResolvedValue([
      { serviceId: "svc_1", imageRef: "n8nio/n8n:1.2", imageDigest: "sha256:old" },
    ]);

    const status = await evaluateDrift(imageProject(), {
      supported: true,
      mode: "image",
      digestByRef: { "n8nio/n8n:1.2": "sha256:new" },
    });

    expect(status).toMatchObject({ behind: true });
  });

  it("ignores a digest polled for a tag the service no longer uses", async () => {
    // Service retagged 1.2 → 1.3 and redeployed. The cached digest for 1.2 must
    // not be compared against 1.3's running digest, or the app reads as behind
    // forever.
    serviceRepo.listByProject.mockResolvedValue([svc({ image: "n8nio/n8n:1.3" })]);
    serviceRepo.listByDeployment.mockResolvedValue([
      { serviceId: "svc_1", imageRef: "n8nio/n8n:1.3", imageDigest: "sha256:onethree" },
    ]);

    const status = await evaluateDrift(imageProject(), {
      supported: true,
      mode: "image",
      digestByRef: { "n8nio/n8n:1.2": "sha256:onetwo" },
    });

    expect(status).toMatchObject({ behind: false });
    expect(status).toMatchObject({ services: [expect.objectContaining({ latestDigest: null })] });
  });

  it("sees a service added since the poll, and claims no drift for it", async () => {
    serviceRepo.listByProject.mockResolvedValue([
      svc(),
      svc({ id: "svc_2", name: "worker", image: "n8nio/n8n:1.9" }),
    ]);
    serviceRepo.listByDeployment.mockResolvedValue([
      { serviceId: "svc_1", imageRef: "n8nio/n8n:1.2", imageDigest: "sha256:same" },
    ]);

    const status = await evaluateDrift(imageProject(), {
      supported: true,
      mode: "image",
      digestByRef: { "n8nio/n8n:1.2": "sha256:same" },
    });

    expect(status).toMatchObject({ supported: true, behind: false });
    expect((status as { services: unknown[] }).services).toHaveLength(2);
  });

  it("becomes unsupported when the project has no image services left", async () => {
    serviceRepo.listByProject.mockResolvedValue([svc({ build: { context: "." }, image: null })]);

    const status = await evaluateDrift(imageProject(), {
      supported: true,
      mode: "image",
      digestByRef: { "n8nio/n8n:1.2": "sha256:new" },
    });

    expect(status).toEqual({ supported: false });
  });
});
