import { appendFileSync, readFileSync } from "node:fs";
import {
  trustedResumeRun,
  successfulJob,
  type ReleaseHistoryRun,
  type ResumeJob,
} from "./release-resume";

type Get = <T>(path: string) => Promise<T>;
const guidance =
  "Finish the Docker images workflow for this exact release tag and commit, then rerun Release. For an older npm-only repair, supply its published Release run as npm_release_run.";

export function verifiedDockerImages(
  repository: string,
  tag: string,
  sha: string,
  run: ReleaseHistoryRun,
  jobs: ResumeJob[],
): void {
  if (
    !trustedResumeRun(run, repository, tag) ||
    run.path !== ".github/workflows/docker-images.yml" ||
    run.head_sha !== sha ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !successfulJob(jobs, "Publish buildkit (manifest)") ||
    !successfulJob(jobs, "Publish api (manifest)")
  )
    throw new Error(
      `The protected-worker image receipt is not a successful matching publication. ${guidance}`,
    );
}

async function pages<T>(get: Get, path: string, key: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await get<Record<string, T[]>>(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    if (!Array.isArray(result[key])) throw new Error("Invalid Docker image publication evidence.");
    all.push(...result[key]);
    if (result[key].length < 100) return all;
  }
  throw new Error("Docker image publication evidence exceeded its page limit.");
}

async function assertTagCommit(get: Get, tag: string, sha: string) {
  let { object } = await get<{ object: { type: string; sha: string } }>(
    `git/ref/tags/${encodeURIComponent(tag)}`,
  );
  for (let depth = 0; object.type === "tag" && depth < 5; depth++)
    ({ object } = await get<{ object: typeof object }>(`git/tags/${object.sha}`));
  if (object.type !== "commit" || object.sha !== sha)
    throw new Error(`The version tag no longer matches this release source. ${guidance}`);
}

/** Read evidence from the already-running image workflow; never dispatch a build
 * or accept another branch, manual publication, repository or moved version tag. */
export async function waitForDockerImages(options: {
  repository: string;
  tag: string;
  sha: string;
  get: Get;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<number> {
  const { repository, tag, sha } = options;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag) ||
    !/^[a-f0-9]{40}$/.test(sha)
  )
    throw new Error("Invalid release image receipt identity.");
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 90 * 60_000);
  const timedOut = () =>
    new Error(`Timed out waiting for the matching Docker image publication. ${guidance}`);
  const get: Get = async <T>(path: string) => {
    if (now() >= deadline) throw timedOut();
    return options.get<T>(path);
  };
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await assertTagCommit(get, tag, sha);
  while (now() < deadline) {
    const runs = await pages<ReleaseHistoryRun>(
      get,
      `actions/workflows/docker-images.yml/runs?event=push&branch=${encodeURIComponent(tag)}`,
      "workflow_runs",
    );
    const run = runs
      .filter(
        (item) =>
          trustedResumeRun(item, repository, tag) &&
          item.path === ".github/workflows/docker-images.yml" &&
          item.head_sha === sha,
      )
      .sort((a, b) => b.id - a.id)[0];
    if (run?.status === "completed") {
      if (run.conclusion !== "success")
        throw new Error(
          `Docker image publication run ${run.id} finished with ${run.conclusion}. ${guidance}`,
        );
      const jobs = await pages<ResumeJob>(get, `actions/runs/${run.id}/jobs?filter=latest`, "jobs");
      verifiedDockerImages(repository, tag, sha, run, jobs);
      await assertTagCommit(get, tag, sha);
      return run.id;
    }
    await sleep(Math.min(15_000, Math.max(0, deadline - now())));
  }
  throw timedOut();
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const sha = process.env.GITHUB_SHA ?? "";
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required to verify image publication.");
  const { version } = JSON.parse(
    readFileSync(new URL("../apps/api/package.json", import.meta.url), "utf8"),
  );
  const tag = `v${version}`;
  if (process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF_NAME !== tag)
    throw new Error("The release tag must match the embedded API version.");
  const get: Get = async <T>(path: string) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `GitHub returned HTTP ${response.status} while verifying release images. ${guidance}`,
      );
    return response.json() as Promise<T>;
  };
  const runId = await waitForDockerImages({ repository, tag, sha, get });
  const receipt = `Protected worker and Docker images verified for ${tag} at ${sha}: https://github.com/${repository}/actions/runs/${runId}`;
  console.info(receipt);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${receipt}\n`);
}
