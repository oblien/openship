import { z } from "zod";
import { AppError } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { cacheStore } from "../../lib/cache-store/index";
import { ghFetchPublic } from "../github/github.http";
import { githubFetch, type GitHubFetchOptions } from "../github/github.auth";

const identifier = z.number().int().positive().safe();
const timestamp = z.string().datetime({ offset: true }).nullable();
const repository = z.object({
  id: identifier,
  full_name: z.string(),
  default_branch: z.string().optional(),
});
const runnerDownload = z.object({
  os: z.string(),
  architecture: z.string(),
  download_url: z.string().url(),
  filename: z.string(),
  sha256_checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export const githubWorkflowSchema = z.object({
  id: identifier,
  path: z.string(),
  name: z.string(),
  state: z.string(),
  html_url: z.string().url(),
});
export const githubRunSchema = z.object({
  id: identifier,
  workflow_id: identifier,
  run_number: identifier,
  run_attempt: identifier,
  head_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
  head_branch: z.string().nullable(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  path: z.string(),
  html_url: z.string().url(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  run_started_at: timestamp.optional(),
  actor: z.object({ login: z.string() }).nullable(),
  repository,
  head_repository: repository.nullable(),
  pull_requests: z.array(z.object({ number: identifier })).optional(),
});
export const githubJobSchema = z.object({
  id: identifier,
  run_id: identifier,
  run_attempt: identifier,
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
  html_url: z.string().url(),
  check_run_url: z.string().url(),
  started_at: timestamp,
  completed_at: timestamp,
  runner_id: z.number().int().nonnegative().safe().nullable(),
  runner_name: z.string().nullable(),
  labels: z.array(z.string()),
  steps: z
    .array(
      z.object({
        number: identifier,
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable(),
        started_at: timestamp.optional(),
        completed_at: timestamp.optional(),
      }),
    )
    .default([]),
});
export type GitHubWorkflowRun = z.infer<typeof githubRunSchema>;
export type GitHubWorkflowJob = z.infer<typeof githubJobSchema>;

/** Authentication, tenant grants and mutation retry policy stay in githubFetch. */
export class GitHubActionsApi {
  readonly root: string;
  constructor(
    readonly ctx: ExecutionContext,
    readonly owner: string,
    readonly repo: string,
  ) {
    this.root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    method: GitHubFetchOptions["method"] = "GET",
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!path.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(path))
      throw new Error("Invalid GitHub Actions API path");
    const value = await githubFetch<unknown>({
      ctx: this.ctx,
      owner: this.owner,
      repo: this.repo,
      url: `${this.root}${path}`,
      method,
      params,
    });
    const result = schema.safeParse(value);
    if (!result.success)
      throw new AppError(
        "GitHub Actions returned an incomplete response. Refresh the workflow to reconcile its state.",
        502,
        "ACTIONS_GITHUB_RESPONSE_INVALID",
      );
    return result.data;
  }
  async matchingRefs(name: string) {
    const result: string[] = [];
    for (const kind of ["heads", "tags"]) {
      const refs = await this.request(
        `/git/matching-refs/${kind}/${encodeURIComponent(name)}`,
        z.array(z.object({ ref: z.string() })),
      );
      result.push(...refs.map((item) => item.ref));
    }
    return result;
  }
  async redirect(path: string) {
    const value = await githubFetch<{ url: string }>({
      ctx: this.ctx,
      owner: this.owner,
      repo: this.repo,
      url: `${this.root}${path}`,
      response: "redirect",
    });
    const url = new URL(value.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !["github.com", "githubusercontent.com", "blob.core.windows.net"].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    )
      throw new AppError(
        "GitHub returned an invalid download location",
        502,
        "ACTIONS_GITHUB_RESPONSE_INVALID",
      );
    return { url: url.href };
  }
  async artifacts(runId: string) {
    const schema = z.object({
      id: identifier,
      name: z.string(),
      size_in_bytes: z.number().nonnegative(),
      expired: z.boolean(),
      created_at: z.string(),
      expires_at: z.string(),
    });
    const result: z.infer<typeof schema>[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request(
        `/actions/runs/${encodeURIComponent(runId)}/artifacts?per_page=100&page=${page}`,
        z.object({ total_count: z.number(), artifacts: z.array(schema) }),
      );
      result.push(...batch.artifacts);
      if (result.length >= batch.total_count) return result;
    }
    throw new AppError(
      "GitHub artifact listing is incomplete",
      502,
      "ACTIONS_GITHUB_RESPONSE_INVALID",
    );
  }
  workflow(path: string) {
    return this.request(
      `/actions/workflows/${encodeURIComponent(path.split("/").at(-1)!)}`,
      githubWorkflowSchema,
    );
  }
  run(id: string) {
    return this.request(`/actions/runs/${encodeURIComponent(id)}`, githubRunSchema);
  }
  attempt(id: string, attempt: number) {
    return this.request(
      `/actions/runs/${encodeURIComponent(id)}/attempts/${attempt}`,
      githubRunSchema,
    );
  }
  async runs(workflowId: string, page = 1) {
    return (
      await this.request(
        `/actions/workflows/${encodeURIComponent(workflowId)}/runs?per_page=100&page=${page}`,
        z.object({ total_count: z.number(), workflow_runs: z.array(githubRunSchema) }),
      )
    ).workflow_runs;
  }
  async jobs(runId: string, attempt: number) {
    const jobs: GitHubWorkflowJob[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request(
        `/actions/runs/${encodeURIComponent(runId)}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
        z.object({ total_count: z.number(), jobs: z.array(githubJobSchema) }),
      );
      jobs.push(...batch.jobs);
      if (jobs.length >= batch.total_count) return jobs;
    }
    throw new AppError(
      "This GitHub run has too many jobs to synchronize in one request",
      502,
      "ACTIONS_GITHUB_JOBS_INCOMPLETE",
    );
  }
  dispatch(workflowId: string, ref: string, inputs: Record<string, unknown>) {
    return this.request(
      `/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      z.object({
        workflow_run_id: identifier,
        run_url: z.string().url(),
        html_url: z.string().url(),
      }),
      "POST",
      { ref, inputs, return_run_details: true },
    );
  }
  cancel(runId: string) {
    return this.request(`/actions/runs/${encodeURIComponent(runId)}/cancel`, z.unknown(), "POST");
  }
  rerun(runId: string) {
    return this.request(`/actions/runs/${encodeURIComponent(runId)}/rerun`, z.unknown(), "POST");
  }
  approve(runId: string) {
    return this.request(`/actions/runs/${encodeURIComponent(runId)}/approve`, z.unknown(), "POST");
  }
  async runners() {
    const schema = z.object({
      id: identifier,
      name: z.string(),
      status: z.string(),
      busy: z.boolean(),
      labels: z.array(z.object({ name: z.string() })),
    });
    const runners: z.infer<typeof schema>[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request(
        `/actions/runners?per_page=100&page=${page}`,
        z.object({ total_count: z.number(), runners: z.array(schema) }),
      );
      runners.push(...batch.runners);
      if (runners.length >= batch.total_count) return runners;
    }
    throw new AppError(
      "GitHub runner registration could not be reconciled",
      502,
      "ACTIONS_GITHUB_RUNNERS_INCOMPLETE",
    );
  }
  registrationToken() {
    return this.request(
      "/actions/runners/registration-token",
      z.object({ token: z.string().min(1), expires_at: z.string().datetime({ offset: true }) }),
      "POST",
    );
  }
  removeRunner(id: string) {
    return this.request(`/actions/runners/${encodeURIComponent(id)}`, z.unknown(), "DELETE");
  }
  async downloads() {
    const catalog = await this.request(
      "/actions/runners/downloads",
      z.array(runnerDownload.extend({ sha256_checksum: z.string().nullable().optional() })),
    );
    const downloads = catalog.flatMap((item) => {
      const parsed = runnerDownload.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
    if (downloads.length) return downloads;
    // GitHub can return an empty repository download catalog. The official
    // public release API supplies signed asset digests without a user token.
    const cache = await cacheStore<z.infer<typeof runnerDownload>[]>("github-official-runner", {
      maxSize: 1,
    });
    const cached = await cache.get("latest");
    if (cached) return cached;
    const release = z
      .object({
        assets: z.array(
          z.object({
            name: z.string(),
            browser_download_url: z.string().url(),
            digest: z.string().nullable(),
          }),
        ),
      })
      .safeParse(
        await ghFetchPublic({ url: "https://api.github.com/repos/actions/runner/releases/latest" }),
      );
    if (!release.success)
      throw new AppError(
        "The official GitHub runner release is unavailable",
        503,
        "ACTIONS_GITHUB_RUNNER_UNAVAILABLE",
      );
    const assets = release.data.assets.flatMap((asset) => {
      const match = /^actions-runner-(linux|osx)-(x64|arm64)-[0-9.]+\.tar\.gz$/.exec(asset.name);
      if (!match || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) return [];
      return [
        {
          os: match[1]!,
          architecture: match[2]!,
          filename: asset.name,
          download_url: asset.browser_download_url,
          sha256_checksum: asset.digest!.slice(7),
        },
      ];
    });
    if (!assets.length)
      throw new AppError(
        "GitHub has not published verified runner downloads",
        503,
        "ACTIONS_GITHUB_RUNNER_UNAVAILABLE",
      );
    // Only public release metadata is shared; repository credentials and
    // registration tokens are never part of this cache.
    await cache.set("latest", assets, 4 * 60 * 60);
    return assets;
  }
}
