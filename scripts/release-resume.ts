import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

/** A resumed tag records actual workflow runs, never a list of checks to bypass. */
export const RESUME_TRAILER = "OpenShip-Resume-Runs:";
export const RESUME_GUARD = "steps.resume.outputs.reused != 'true'";
const workflows = new Set([
  ".github/workflows/release.yml",
  ".github/workflows/docker-images.yml",
  ".github/workflows/release-gate.yml",
  ".github/workflows/scaling-e2e.yml",
  ".github/workflows/actions-e2e.yml",
]);

export function resumeRuns(annotation: string): string[] {
  const lines = annotation.split("\n").filter((line) => line.startsWith(RESUME_TRAILER));
  if (!lines.length) return [];
  if (lines.length !== 1) throw new Error("The release has conflicting resume records.");
  const ids = lines[0]!.slice(RESUME_TRAILER.length).trim().split(",");
  if (ids.length > 12 || ids.some((id) => !/^[1-9]\d{0,15}$/.test(id)))
    throw new Error("The release has an invalid resume record.");
  return [...new Set(ids)];
}

/** Only paths known to be exclusive to a journey can be omitted. Unknown paths,
 * all production code, dependencies and configuration invalidate every result. */
export function affectsScope(path: string, scope: string): boolean {
  if (workflows.has(path)) return false; // Compared structurally below.
  if (
    [
      "scripts/release.ts",
      "scripts/release-args.ts",
      "scripts/release-resume.ts",
      "scripts/release-resume.test.ts",
    ].includes(path) ||
    path === ".github/actions/release-resume/action.yml"
  )
    return false;
  // Native/API archives can contain source and fixture files. Builds retain the
  // full tree as input; only the installed SDK excludes the API's test tree.
  if (scope === "sdk" && path.startsWith("apps/api/test/")) return false;
  const exclusive =
    path === "apps/api/test/helpers/cluster-host-lab.ts" ||
    path.startsWith("apps/api/test/fixtures/cluster-host/")
      ? "storage"
      : path === "apps/api/test/e2e/scaling-stateful.e2e.test.ts"
        ? "storage"
        : path === "apps/api/test/e2e/scaling-databases.e2e.test.ts"
          ? "databases"
          : path === "apps/api/test/e2e/scaling-full-cycle.e2e.test.ts"
            ? "application"
            : path === "apps/api/test/e2e/rollback-build-restore.e2e.test.ts"
              ? "heavy"
              : path === "apps/api/test/e2e/actions-runner.e2e.test.ts" || path === "apps/api/test/helpers/workspace-runtime.ts"
                ? "actions-linux"
                : path === "apps/api/test/e2e/update-from-previous-release.e2e.test.ts"
                ? "update"
                : path.startsWith("apps/api/test/e2e/")
                  ? "fast"
                  : undefined;
  return exclusive ? scope === "build" || scope === exclusive : true;
}

type RecordValue = Record<string, any>;

/** Ignore only the resume wrapper and history depth. Commands, action versions,
 * environments, runner, matrix, timeouts and original conditions must match. */
export function jobSignature(source: string, jobId: string): string {
  const workflow = Bun.YAML.parse(source) as RecordValue;
  const job = structuredClone(workflow.jobs?.[jobId]);
  if (!job) throw new Error(`Missing workflow job: ${jobId}`);
  job.steps = job.steps
    ?.filter((step: RecordValue) => {
      return !(step.id === "resume" && step.uses === "./.github/actions/release-resume");
    })
    .map((step: RecordValue) => {
      if (step.if === RESUME_GUARD) delete step.if;
      else if (
        typeof step.if === "string" &&
        step.if.startsWith(`${RESUME_GUARD} && (`) &&
        step.if.endsWith(")")
      )
        step.if = step.if.slice(`${RESUME_GUARD} && (`.length, -1);
      if (step.uses?.startsWith("actions/checkout@") && step.with) {
        delete step.with["fetch-depth"];
        if (!Object.keys(step.with).length) delete step.with;
      }
      return step;
    });
  // Object key order is not meaningful in a workflow.
  const stable = (value: any): any =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable(value[key])]),
          )
        : value;
  return JSON.stringify(stable({ env: workflow.env, defaults: workflow.defaults, job }));
}

export interface ResumeRun {
  id: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  repository: { full_name: string };
  head_repository?: { full_name: string };
}
export interface ReleaseHistoryRun extends ResumeRun {
  status: string;
  conclusion: string | null;
}
export interface ResumeJob {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  steps?: Array<{ name: string; status: string; conclusion: string | null }>;
}

/** Bind the reuse inputs to the real job, including its matrix expression.
 * An accidentally copied action block must not certify a different check. */
export function assertResumeBinding(source: string, workflowPath: string, jobId: string) {
  const job = (Bun.YAML.parse(source) as RecordValue).jobs?.[jobId];
  const inputs = job?.steps?.find((step: RecordValue) => step.id === "resume")?.with;
  if (!inputs) throw new Error("The job does not declare its resume inputs.");
  const scope =
    workflowPath.endsWith("/actions-e2e.yml") && ["linux", "macos"].includes(jobId)
      ? `actions-${jobId}`
      : workflowPath.endsWith("/scaling-e2e.yml") && jobId === "scaling"
      ? "${{ matrix.journey }}"
      : workflowPath.endsWith("/release-gate.yml")
        ? (
            { test: "unit", "sdk-package": "sdk", "e2e-docker": "${{ matrix.scope }}" } as Record<
              string,
              string
            >
          )[jobId]
        : jobId.startsWith("build-")
          ? "build"
          : undefined;
  const artifact =
    scope === "build"
      ? job.steps.find((step: RecordValue) => step.uses?.startsWith("actions/upload-artifact@"))
          ?.with?.name
      : undefined;
  if (
    !scope ||
    inputs.scope !== scope ||
    inputs["job-name"] !== job.name ||
    inputs.workflow !== workflowPath ||
    inputs["job-id"] !== jobId ||
    (inputs.artifact || undefined) !== artifact
  )
    throw new Error("Resume inputs do not match the check or its build artifact.");
}

export function trustedResumeRun(run: ResumeRun, repository: string, tag: string): boolean {
  return (
    run.repository.full_name === repository &&
    run.head_repository?.full_name === repository &&
    run.event === "push" &&
    run.head_branch === tag &&
    /^[a-f0-9]{40}$/.test(run.head_sha) &&
    [".github/workflows/release.yml", ".github/workflows/docker-images.yml"].includes(run.path)
  );
}

export function successfulJob(jobs: ResumeJob[], name: string): ResumeJob | undefined {
  const matches = jobs.filter((job) => job.name === name || job.name.endsWith(` / ${name}`));
  return matches.length === 1 &&
    matches[0]!.status === "completed" &&
    matches[0]!.conclusion === "success"
    ? matches[0]
    : undefined;
}

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 ** 2 }).trim();

async function github<T>(path: string): Promise<T> {
  if (!process.env.GITHUB_TOKEN)
    return JSON.parse(
      execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 16 * 1024 ** 2 }),
    );
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`GitHub returned HTTP ${response.status} while checking release history.`);
  return response.json() as Promise<T>;
}

async function allPages<T>(path: string, key: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await github<Record<string, T[]>>(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    items.push(...result[key]!);
    if (result[key]!.length < 100) return items;
  }
  throw new Error("Release history exceeded the supported page limit.");
}

/** Inspect every attempt, including older reruns. A failed publishing job can
 * already have written public tags. A cancellation with no steps never ran. */
export async function unpublishedReleaseRuns(
  repository: string,
  tag: string,
): Promise<ReleaseHistoryRun[]> {
  const previous: ReleaseHistoryRun[] = [];
  for (const workflow of ["release.yml", "docker-images.yml"]) {
    const runs = await allPages<ReleaseHistoryRun>(
      `repos/${repository}/actions/workflows/${workflow}/runs?event=push&branch=${encodeURIComponent(tag)}`,
      "workflow_runs",
    );
    for (const run of runs.filter((item) => item.head_branch === tag)) {
      if (run.status !== "completed")
        throw new Error(
          `${workflow} run ${run.id} is still running. Let it finish before continuing the release.`,
        );
      const jobs = await allPages<ResumeJob>(
        `repos/${repository}/actions/runs/${run.id}/jobs?filter=all`,
        "jobs",
      );
      if (
        jobs.some(
          (job) =>
            job.name.startsWith("Publish ") &&
            job.conclusion !== "skipped" &&
            !(job.conclusion === "cancelled" && job.steps?.length === 0),
        )
      )
        throw new Error(
          `${tag} has a publishing attempt in run ${run.id}. Release a new version instead of replacing potentially published artifacts.`,
        );
      previous.push(run);
    }
  }
  return previous.sort((a, b) => b.id - a.id);
}

export async function findReusableJob(options: {
  repository: string;
  tag: string;
  runIds: string[];
  scope: string;
  jobName: string;
  workflow: string;
  jobId: string;
  artifact?: string;
}): Promise<{ runId: string; url: string; artifactId?: number } | undefined> {
  if (!workflows.has(options.workflow)) throw new Error("Unknown release workflow.");
  if (git("status", "--porcelain", "--untracked-files=normal")) return undefined;
  const currentSource = readFileSync(options.workflow, "utf8");
  assertResumeBinding(currentSource, options.workflow, options.jobId);
  const currentSignature = jobSignature(currentSource, options.jobId);
  for (const id of options.runIds) {
    if (id === process.env.GITHUB_RUN_ID) continue;
    const run = await github<ResumeRun>(`repos/${options.repository}/actions/runs/${id}`);
    if (!trustedResumeRun(run, options.repository, options.tag)) continue;
    // Image labels embed the commit, even when the filesystem layers match.
    if (
      options.workflow.endsWith("/docker-images.yml") &&
      options.jobId === "build-images" &&
      run.head_sha !== git("rev-parse", "HEAD")
    )
      continue;
    const jobs = await allPages<ResumeJob>(
      `repos/${options.repository}/actions/runs/${id}/jobs?filter=latest`,
      "jobs",
    );
    const job = successfulJob(jobs, options.jobName);
    if (!job) continue;
    // A resume can use a previous revision, never an unrelated branch's run.
    try {
      git("merge-base", "--is-ancestor", run.head_sha, "HEAD");
    } catch {
      continue;
    }
    if (
      jobSignature(git("show", `${run.head_sha}:${options.workflow}`), options.jobId) !==
      currentSignature
    )
      continue;
    const changed = git("diff", "--no-renames", "--name-only", "-z", run.head_sha, "HEAD")
      .split("\0")
      .filter(Boolean);
    if (changed.some((path) => affectsScope(path, options.scope))) continue;
    let artifactId: number | undefined;
    if (options.artifact) {
      const artifacts = await allPages<{ id: number; name: string; expired: boolean }>(
        `repos/${options.repository}/actions/runs/${id}/artifacts`,
        "artifacts",
      );
      const matches = artifacts.filter(
        (artifact) => artifact.name === options.artifact && !artifact.expired,
      );
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0]!.id)) continue;
      artifactId = matches[0]!.id;
    }
    return { runId: id, url: job.html_url, ...(artifactId === undefined ? {} : { artifactId }) };
  }
}

async function main() {
  let result: Awaited<ReturnType<typeof findReusableJob>>;
  if (
    process.env.GITHUB_SHA &&
    git("rev-parse", `${process.env.GITHUB_SHA}^{commit}`) !== git("rev-parse", "HEAD")
  )
    throw new Error("The checkout does not match this workflow's immutable revision.");
  // Manual npm/image publishing and ordinary tags always run the complete gate.
  if (
    process.env.GITHUB_REF_TYPE === "tag" &&
    /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(process.env.GITHUB_REF_NAME ?? "")
  ) {
    const tag = process.env.GITHUB_REF_NAME!;
    const runIds = resumeRuns(git("for-each-ref", `refs/tags/${tag}`, "--format=%(contents)"));
    if (runIds.length)
      result = await findReusableJob({
        repository: process.env.GITHUB_REPOSITORY!,
        tag,
        runIds,
        scope: process.env.RESUME_SCOPE!,
        jobName: process.env.RESUME_JOB_NAME!,
        workflow: process.env.RESUME_WORKFLOW!,
        jobId: process.env.RESUME_JOB_ID!,
        artifact: process.env.RESUME_ARTIFACT || undefined,
      });
  }
  const message = result
    ? `Reusing ${process.env.RESUME_JOB_NAME}: its inputs and workflow steps are unchanged. ${result.url}`
    : `Running ${process.env.RESUME_JOB_NAME}: no matching successful result with unchanged inputs.`;
  console.info(message);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `reused=${!!result}\nrun-id=${result?.runId ?? ""}\nartifact-id=${result?.artifactId ?? ""}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}

if (import.meta.main) await main();
