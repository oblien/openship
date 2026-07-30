/**
 * `openship logs [deploymentId]` — deployment logs.
 *
 *   default:   GET /api/deployments/:id/logs  → { data: LogEntry[] } (snapshot)
 *   --follow:  GET /api/deployments/:id/stream → SSE build-session stream
 *
 * With no deploymentId, resolve the latest deployment of the linked project so
 * the command the CLI suggests after a failed deploy works without an ID.
 *
 * (deployment.controller.ts:logs / stream)
 */
import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client";
import { streamDeploymentLogs } from "../lib/deploy-stream";
import { isJsonMode, printJson, err } from "../lib/output";
import { readProjectLink } from "../lib/project-link";

interface LogEntry {
  message?: string;
  level?: string;
  timestamp?: string;
}

/**
 * Latest deployment ID for the linked project, or null if the directory isn't
 * linked or the project has no deployments. The list endpoint returns rows
 * newest-first, so the first row is the most recent deployment.
 */
async function resolveLatestDeploymentId(): Promise<string | null> {
  const projectId = readProjectLink()?.projectId;
  if (!projectId) return null;
  const res = await apiRequest<{ data?: { id: string }[] }>(
    `/deployments?projectId=${encodeURIComponent(projectId)}&perPage=1`,
  );
  return res.data?.[0]?.id ?? null;
}

export const logsCommand = new Command("logs")
  .description("View or stream a deployment's logs")
  .argument("[deploymentId]", "Deployment ID (defaults to the latest deployment of the linked project)")
  .option("-f, --follow", "Stream live logs via SSE until the deployment finishes")
  .option("--tail <n>", "Show only the last N log lines (snapshot mode)")
  .action(async (deploymentIdArg: string | undefined, opts) => {
    let deploymentId = deploymentIdArg;
    if (!deploymentId) {
      try {
        deploymentId = (await resolveLatestDeploymentId()) ?? undefined;
      } catch (e) {
        err(e instanceof ApiError ? e.message : String(e));
        process.exit(1);
      }
      if (!deploymentId) {
        err(
          "No deployment ID given and none could be resolved. Pass one explicitly " +
            "(openship logs <deploymentId>), or run inside a linked project directory.",
        );
        process.exit(1);
      }
    }

    if (opts.follow) {
      try {
        const result = await streamDeploymentLogs(deploymentId);
        if (result.success === false || result.status === "cancelled") process.exit(1);
      } catch (e) {
        err(e instanceof ApiError ? e.message : String(e));
        process.exit(1);
      }
      return;
    }

    const query = opts.tail ? `?tail=${encodeURIComponent(opts.tail)}` : "";
    try {
      const res = await apiRequest<{ data?: LogEntry[] }>(
        `/deployments/${deploymentId}/logs${query}`,
      );
      const entries = res.data ?? [];
      if (isJsonMode()) {
        printJson(entries);
        return;
      }
      for (const e of entries) {
        const msg = e.message ?? "";
        process.stdout.write(msg.endsWith("\n") ? msg : msg + "\n");
      }
    } catch (e) {
      err(e instanceof ApiError ? e.message : String(e));
      process.exit(1);
    }
  });
