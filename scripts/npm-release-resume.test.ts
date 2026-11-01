import { describe, expect, it } from "bun:test";
import { verifiedNpmRelease, type NpmReleaseEvidence } from "./npm-release-resume";

function evidence(): NpmReleaseEvidence {
  return {
    repository: "oblien/openship",
    run: {
      id: 123, head_sha: "a".repeat(40), head_branch: "v0.8.0", event: "push",
      path: ".github/workflows/release.yml", repository: { full_name: "oblien/openship" },
      head_repository: { full_name: "oblien/openship" }, status: "completed", conclusion: "failure",
    },
    tagCommit: "a".repeat(40),
    release: { tag_name: "v0.8.0", draft: false, published_at: "2026-09-27T00:00:00Z" },
    jobs: [
      { name: "Release gate / Scaling E2E / Scaling journey (databases)", status: "completed", conclusion: "success", html_url: "" },
      { name: "Publish GitHub release", status: "completed", conclusion: "success", html_url: "" },
      { name: "Publish Openship to npm", status: "completed", conclusion: "failure", html_url: "" },
    ],
  };
}

describe("npm-only release resumption", () => {
  it("selects the tested release commit, independently of the maintenance branch", () => {
    expect(verifiedNpmRelease(evidence())).toEqual({ sha: "a".repeat(40), tag: "v0.8.0", version: "0.8.0" });
  });
  it.each([
    (e: NpmReleaseEvidence) => { e.run.event = "workflow_dispatch"; },
    (e: NpmReleaseEvidence) => { e.run.head_repository!.full_name = "untrusted/fork"; },
    (e: NpmReleaseEvidence) => { e.run.repository.full_name = "another/repo"; },
    (e: NpmReleaseEvidence) => { e.run.head_branch = "main"; },
    (e: NpmReleaseEvidence) => { e.run.path = ".github/workflows/docker-images.yml"; },
    (e: NpmReleaseEvidence) => { e.run.status = "in_progress"; },
    (e: NpmReleaseEvidence) => { e.tagCommit = "b".repeat(40); },
    (e: NpmReleaseEvidence) => { e.release.draft = true; },
    (e: NpmReleaseEvidence) => { e.release.published_at = null; },
    (e: NpmReleaseEvidence) => { e.release.tag_name = "v0.7.0"; },
    (e: NpmReleaseEvidence) => { e.jobs[0]!.conclusion = "failure"; },
    (e: NpmReleaseEvidence) => { e.jobs[0]!.conclusion = "skipped"; },
    (e: NpmReleaseEvidence) => { e.jobs[0]!.status = "in_progress"; },
    (e: NpmReleaseEvidence) => { e.jobs.shift(); },
    (e: NpmReleaseEvidence) => { e.jobs[1]!.conclusion = "failure"; },
    (e: NpmReleaseEvidence) => { e.jobs.pop(); },
    (e: NpmReleaseEvidence) => { e.jobs.push({ ...e.jobs[1]! }); },
    (e: NpmReleaseEvidence) => { e.jobs.push({ name: "Another build", status: "completed", conclusion: "failure", html_url: "" }); },
  ])("refuses incomplete, mismatched or untrusted evidence (%#)", change => {
    const current = evidence();
    change(current);
    expect(() => verifiedNpmRelease(current)).toThrow();
  });
});
