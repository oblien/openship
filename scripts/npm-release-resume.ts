import { appendFileSync } from "node:fs";
import { trustedResumeRun, successfulJob, type ReleaseHistoryRun, type ResumeJob } from "./release-resume";

export interface NpmReleaseEvidence {
  repository: string;
  run: ReleaseHistoryRun;
  jobs: ResumeJob[];
  tagCommit: string;
  release: { tag_name: string; draft: boolean; published_at: string | null };
}

/** Reuse a completed gate only for the exact source of an already published release. */
export function verifiedNpmRelease(evidence: NpmReleaseEvidence) {
  const { repository, run, jobs, tagCommit, release } = evidence;
  const tag = run.head_branch;
  if (
    !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag) ||
    !trustedResumeRun(run, repository, tag) ||
    run.path !== ".github/workflows/release.yml" ||
    run.status !== "completed"
  ) throw new Error("npm-only resume requires a completed tag-push Release run from this repository.");
  if (tagCommit !== run.head_sha)
    throw new Error("The release tag no longer matches the tested commit.");
  if (release.tag_name !== tag || release.draft || !release.published_at)
    throw new Error("npm-only resume requires the matching published GitHub release.");
  const gate = jobs.filter(job => job.name.startsWith("Release gate / "));
  if (
    !gate.length ||
    gate.some(job => job.status !== "completed" || job.conclusion !== "success") ||
    !successfulJob(jobs, "Publish GitHub release") ||
    jobs.filter(job => job.name === "Publish Openship to npm").length !== 1 ||
    jobs.some(job => job.status !== "completed" || (
      job.name !== "Publish Openship to npm" &&
      job.conclusion !== "success" && job.conclusion !== "skipped"
    ))
  ) throw new Error("The original release must have passed every gate and completed all other publishing work.");
  return { sha: run.head_sha, tag, version: tag.slice(1) };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const runId = process.env.OPENSHIP_NPM_RELEASE_RUN ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[1-9]\d{0,15}$/.test(runId))
    throw new Error("Provide a valid repository and original Release run ID.");
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required to verify the original release.");
  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} while verifying the npm release source.`);
    return response.json() as Promise<T>;
  }
  const run = await get<ReleaseHistoryRun>(`actions/runs/${runId}`);
  if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(run.head_branch))
    throw new Error("The original release run must refer to a version tag.");
  const jobs: ResumeJob[] = [];
  for (let page = 1; ; page++) {
    if (page > 20) throw new Error("The release job history exceeded its supported page limit.");
    const result = await get<{ jobs: ResumeJob[] }>(`actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
  }
  const ref = await get<{ object: { type: string; sha: string } }>(`git/ref/tags/${encodeURIComponent(run.head_branch)}`);
  let object = ref.object;
  for (let depth = 0; object.type === "tag" && depth < 5; depth++) {
    object = (await get<{ object: typeof object }>(`git/tags/${object.sha}`)).object;
  }
  if (object.type !== "commit") throw new Error("The release tag does not resolve to a commit.");
  const release = await get<NpmReleaseEvidence["release"]>(`releases/tags/${encodeURIComponent(run.head_branch)}`);
  const source = verifiedNpmRelease({ repository, run, jobs, tagCommit: object.sha, release });
  if (process.env.OPENSHIP_NPM_EXPECTED_SHA && process.env.OPENSHIP_NPM_EXPECTED_SHA !== source.sha)
    throw new Error("The verified npm release source changed during publication.");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${source.sha}\ntag=${source.tag}\nversion=${source.version}\n`);
  const message = `npm-only resume: build ${source.tag} from tested commit ${source.sha}; gates verified in https://github.com/${repository}/actions/runs/${runId}`;
  console.info(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}

if (import.meta.main) await main();
