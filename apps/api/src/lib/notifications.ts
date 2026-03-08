/**
 * Deployment notifications — email alerts for build/deploy lifecycle events.
 *
 * Uses the existing SMTP transport from lib/mail.ts.
 * Gracefully no-ops when SMTP is not configured (self-hosted without email).
 *
 * Event types:
 *   - deployment_success  — build & deploy completed
 *   - build_failed        — build phase failed
 *   - deployment_failed   — deploy phase failed (container didn't start)
 *   - push_received       — git push triggered a deployment
 *   - ssl_expiring        — TLS certificate expires soon
 *   - ssl_renewed         — TLS certificate was auto-renewed
 *   - project_limit       — user approaching project/build limits
 */

import { sendMail, smtpEnabled } from "./mail";
import { env } from "../config/env";

// ─── Event types ─────────────────────────────────────────────────────────────

export type NotificationEvent =
  | "deployment_success"
  | "build_failed"
  | "deployment_failed"
  | "push_received"
  | "ssl_expiring"
  | "ssl_renewed"
  | "project_limit";

export interface NotificationContext {
  /** User email to send to */
  email: string;
  /** Project name */
  projectName: string;
  /** Additional event-specific data */
  data?: Record<string, unknown>;
}

// ─── Templates ───────────────────────────────────────────────────────────────

function subjectFor(event: NotificationEvent, ctx: NotificationContext): string {
  switch (event) {
    case "deployment_success":
      return `✅ Deployment succeeded — ${ctx.projectName}`;
    case "build_failed":
      return `❌ Build failed — ${ctx.projectName}`;
    case "deployment_failed":
      return `❌ Deployment failed — ${ctx.projectName}`;
    case "push_received":
      return `🔄 New push detected — ${ctx.projectName}`;
    case "ssl_expiring":
      return `⚠️ SSL certificate expiring — ${ctx.data?.domain ?? ctx.projectName}`;
    case "ssl_renewed":
      return `🔒 SSL certificate renewed — ${ctx.data?.domain ?? ctx.projectName}`;
    case "project_limit":
      return `⚠️ Approaching project limit`;
  }
}

function htmlFor(event: NotificationEvent, ctx: NotificationContext): string {
  const dashboardUrl = env.DASHBOARD_URL;
  const d = ctx.data ?? {};

  switch (event) {
    case "deployment_success":
      return `
        <h2>Deployment Succeeded</h2>
        <p><strong>${ctx.projectName}</strong> was deployed successfully.</p>
        ${d.branch ? `<p>Branch: <code>${d.branch}</code></p>` : ""}
        ${d.commitSha ? `<p>Commit: <code>${String(d.commitSha).slice(0, 7)}</code></p>` : ""}
        ${d.url ? `<p>Live at: <a href="${d.url}">${d.url}</a></p>` : ""}
        ${d.durationMs ? `<p>Build time: ${Math.round(Number(d.durationMs) / 1000)}s</p>` : ""}
        <p><a href="${dashboardUrl}">Open Dashboard</a></p>
      `;

    case "build_failed":
      return `
        <h2>Build Failed</h2>
        <p>The build for <strong>${ctx.projectName}</strong> failed.</p>
        ${d.branch ? `<p>Branch: <code>${d.branch}</code></p>` : ""}
        ${d.error ? `<p>Error: <code>${d.error}</code></p>` : ""}
        ${d.logs ? `<details><summary>Build Logs (last 50 lines)</summary><pre>${d.logs}</pre></details>` : ""}
        <p><a href="${dashboardUrl}">Open Dashboard</a></p>
      `;

    case "deployment_failed":
      return `
        <h2>Deployment Failed</h2>
        <p>The container for <strong>${ctx.projectName}</strong> failed to start.</p>
        ${d.error ? `<p>Error: <code>${d.error}</code></p>` : ""}
        <p><a href="${dashboardUrl}">Open Dashboard</a></p>
      `;

    case "push_received":
      return `
        <h2>New Push Detected</h2>
        <p>A new push was received for <strong>${ctx.projectName}</strong>.</p>
        ${d.branch ? `<p>Branch: <code>${d.branch}</code></p>` : ""}
        ${d.author ? `<p>Author: ${d.author}</p>` : ""}
        ${d.commitMessage ? `<p>Message: ${d.commitMessage}</p>` : ""}
        <p>A new deployment has been triggered automatically.</p>
      `;

    case "ssl_expiring":
      return `
        <h2>SSL Certificate Expiring</h2>
        <p>The TLS certificate for <strong>${d.domain}</strong> expires in <strong>${d.daysLeft} days</strong>.</p>
        <p>Auto-renewal will be attempted. If it fails, manual intervention may be required.</p>
      `;

    case "ssl_renewed":
      return `
        <h2>SSL Certificate Renewed</h2>
        <p>The TLS certificate for <strong>${d.domain}</strong> has been renewed.</p>
        ${d.expiresAt ? `<p>New expiry: ${d.expiresAt}</p>` : ""}
      `;

    case "project_limit":
      return `
        <h2>Approaching Project Limit</h2>
        <p>You are using <strong>${d.current}</strong> of <strong>${d.limit}</strong> allowed projects.</p>
        <p>Consider archiving unused projects or upgrading your plan.</p>
      `;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a deployment lifecycle notification.
 * No-ops when SMTP is unconfigured — safe to call unconditionally.
 */
export async function notify(
  event: NotificationEvent,
  ctx: NotificationContext,
): Promise<void> {
  if (!smtpEnabled) return;

  try {
    await sendMail({
      to: ctx.email,
      subject: subjectFor(event, ctx),
      html: htmlFor(event, ctx),
    });
  } catch (err) {
    // Never throw from notifications — they are best-effort
    console.error(`[notify] Failed to send ${event} email to ${ctx.email}:`, err);
  }
}

/**
 * Convenience: send a deployment success notification.
 */
export async function notifyDeploySuccess(
  email: string,
  project: { name: string },
  deployment: { branch: string; commitSha?: string | null; url?: string | null; durationMs?: number },
): Promise<void> {
  await notify("deployment_success", {
    email,
    projectName: project.name,
    data: {
      branch: deployment.branch,
      commitSha: deployment.commitSha,
      url: deployment.url,
      durationMs: deployment.durationMs,
    },
  });
}

/**
 * Convenience: send a build failure notification.
 */
export async function notifyBuildFailed(
  email: string,
  project: { name: string },
  details: { branch: string; error: string; logs?: string },
): Promise<void> {
  // Trim logs to last 50 lines to avoid huge emails
  const trimmedLogs = details.logs
    ?.split("\n")
    .slice(-50)
    .join("\n");

  await notify("build_failed", {
    email,
    projectName: project.name,
    data: {
      branch: details.branch,
      error: details.error,
      logs: trimmedLogs,
    },
  });
}
