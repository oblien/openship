import { AppError, safeErrorMessage } from "@repo/core";
import { diagnostics, redactDiagnosticText } from "@repo/core/diagnostics";
import type { ExecutionContext } from "@repo/platform";
import { githubFetch, getInstallationToken } from "./github.auth";
import { GitHubApiError } from "./github.http";

export interface GitHubCheckUpdate {
  name: string;
  externalId: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "cancelled" | "neutral" | "skipped" | "timed_out" | "action_required";
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
  output: { title: string; summary: string };
}

/** Bounded summaries only. Do not attach build logs, environments or provider payloads. */
export function checkFailureSummary(message: string, secrets: readonly string[] = []): string {
  let text = message;
  // Redact literal values before truncating the public summary. Even ordinary
  // variable names can contain credentials, so callers supply all captured env values.
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, "[REDACTED]");
  }
  return redactDiagnosticText(text.slice(0, 16_384), 4000);
}

/** Shared transport for workflow and deployment Checks, pinned to the scoped App. */
export async function syncGitHubCheck(
  ctx: ExecutionContext,
  owner: string,
  repo: string,
  id: string | null,
  update: GitHubCheckUpdate,
  options?: { canSend?: () => Promise<boolean>; createIfMissing?: boolean },
): Promise<{ id: string | null; error: string | null; unavailable?: boolean; skipped?: boolean }> {
  try {
    if (!await getInstallationToken(ctx, owner, undefined, { repositories: [repo] }))
      return { id, error: "Connect a GitHub App with Checks write permission for this repository.", unavailable: true };
    const root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const request = async <T>(url: string, method: "GET" | "POST" | "PATCH" = "GET", params?: Record<string, unknown>) => {
      if (options?.canSend && !await options.canSend()) throw new Error("GitHub Check delivery lease ended");
      return githubFetch<T>({ ctx, owner, repo, url, method, params, authorizeAs: "read", credential: ["app-installation"] });
    };
    if (!id) {
      // The POST may have succeeded before its response was lost. Recover by
      // attempt identity, never by name alone (several deployments can share a SHA).
      for (let page = 1; page <= 10; page++) {
        const result = await request<{ check_runs: Array<{ id: number; external_id: string }> }>(
          `${root}/commits/${encodeURIComponent(update.headSha)}/check-runs?filter=all&per_page=100&page=${page}&check_name=${encodeURIComponent(update.name)}`,
        );
        id = result.check_runs.find(check => check.external_id === update.externalId)?.id.toString() ?? null;
        if (id || result.check_runs.length < 100) break;
        if (page === 10) throw new Error("Too many matching Checks to safely identify this attempt");
      }
    }
    if (!id && options?.createIfMissing === false) return { id: null, error: null, skipped: true };
    const body = {
      name: update.name, external_id: update.externalId, status: update.status,
      ...(update.detailsUrl && { details_url: update.detailsUrl }),
      ...(update.startedAt && { started_at: update.startedAt }),
      ...(update.status === "completed" && {
        conclusion: update.conclusion ?? "neutral", completed_at: update.completedAt ?? new Date().toISOString(),
      }),
      output: { title: update.output.title.slice(0, 255), summary: checkFailureSummary(update.output.summary) },
    };
    if (id) await request(`${root}/check-runs/${id}`, "PATCH", body);
    else {
      const created = await request<{ id: number }>(`${root}/check-runs`, "POST", { ...body, head_sha: update.headSha });
      if (!Number.isSafeInteger(created.id) || created.id <= 0) throw new Error("GitHub did not confirm the created Check");
      id = String(created.id);
    }
    return { id, error: null };
  } catch (error) {
    const unavailable = error instanceof AppError && [401, 403, 404].includes(error.statusCode)
      || error instanceof GitHubApiError && (error.credentialRejected || error.status === 404);
    diagnostics.warn("github/checks", "GitHub Check delivery failed", error);
    return { id, error: checkFailureSummary(safeErrorMessage(error)), ...(unavailable && { unavailable: true }) };
  }
}
