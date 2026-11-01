/**
 * What an operator actually reads at the top of an alert.
 *
 * A category is a SUBSCRIPTION, and two of them deliberately carry an event and its
 * own opposite so nobody can subscribe to the bad news only. Rendering the message
 * from the category alone therefore titled a server RECOVERY "Server unreachable",
 * and opened its body with "We can't reach a server's Docker daemon" — one line above
 * "is answering again after 4m 12s". On a phone the subject line is the whole alert,
 * so that reads as a fresh outage.
 */
import { describe, expect, it } from "vitest";
import type { NotificationDelivery } from "@repo/db";

import { renderEmailHtml, renderMessage } from "@repo/platform/engine/lib/notification-workers";

/** The two fields renderMessage reads. The rest of the row is irrelevant here. */
const delivery = (category: string, payload: Record<string, unknown>) =>
  ({ category, payload }) as unknown as NotificationDelivery;

describe("delivered headline vs the category it was subscribed through", () => {
  it("titles a server recovery for what happened, not for the toggle it rode in on", () => {
    const msg = renderMessage(
      delivery("server.unreachable", {
        eventType: "server.reachable",
        message: 'Server "web-1" is answering again after 4m 12s.',
      }),
    );

    expect(msg.title).toBe("Server reachable");
    expect(msg.body).toContain("answering again");
    // The body must not open by asserting the opposite of its own next line.
    expect(msg.body).not.toMatch(/can't reach/i);
  });

  it("leaves the outage alert's own blunt headline alone", () => {
    // The half that must not regress: this is the message somebody is woken by, and
    // the title is the only part a lock screen shows.
    const msg = renderMessage(
      delivery("server.unreachable", {
        eventType: "server.unreachable",
        message: 'Can\'t reach Docker on server "web-1": connect ETIMEDOUT 10.0.0.9:22.',
      }),
    );

    expect(msg.title).toBe("Server unreachable");
    expect(msg.body).toMatch(/can't reach a server's Docker daemon/i);
  });

  it("uses the category for every event type without an override", () => {
    const msg = renderMessage(
      delivery("service.down", { eventType: "service.down", message: "it exited with code 1" }),
    );
    expect(msg.title).toBe("App down");
  });

  it("still names a delivery whose payload carries no eventType", () => {
    // Queued rows outlive a deploy, and the payload is free-form JSON: a missing
    // eventType has to fall back to the category, not render "undefined".
    const msg = renderMessage(delivery("service.recovered", { message: "back up" }));
    expect(msg.title).toBe("App recovered");
  });

  it("renders policy, destination, project, and service names in backup alerts", () => {
    const msg = renderMessage(
      delivery("backup.failed", {
        eventType: "backup_run.failed",
        policyName: "Nightly Database",
        destinationName: "S3 Primary",
        projectName: "Production",
        serviceName: "postgres",
        errorMessage: "Docker stream ended mid-frame with 15433 bytes buffered",
        resourceType: "backup_run",
        resourceId: "bkr_test_123",
      }),
    );

    expect(msg.title).toBe("Backup failed");
    expect(msg.body).toContain("Policy: Nightly Database");
    expect(msg.body).toContain("Destination: S3 Primary");
    expect(msg.body).toContain("Project: Production");
    expect(msg.body).toContain("Service: postgres");
    expect(msg.body).toContain("Error: Docker stream ended mid-frame with 15433 bytes buffered");
    expect(msg.body).toContain("Resource: backup_run (bkr_test_123)");
  });

  it("renders policy and destination for successful backups", () => {
    const msg = renderMessage(
      delivery("backup.succeeded", {
        eventType: "backup_run.succeeded",
        policyName: "Weekly Volume",
        destinationName: "Offsite MinIO",
        projectName: "App",
        serviceName: "redis",
        resourceType: "backup_run",
        resourceId: "bkr_test_456",
      }),
    );

    expect(msg.title).toBe("Backup succeeded");
    expect(msg.body).toContain("Policy: Weekly Volume");
    expect(msg.body).toContain("Destination: Offsite MinIO");
    expect(msg.body).toContain("Project: App");
    expect(msg.body).toContain("Service: redis");
  });

  it("keeps durable backup references when names cannot be resolved", () => {
    const msg = renderMessage(delivery("backup.failed", {
      policyId: "pol_1",
      destinationId: "dst_1",
    }));
    expect(msg.body).toContain("Policy: pol_1");
    expect(msg.body).toContain("Destination: dst_1");
  });

  it("renders job name, exit code, error, duration, resource, and logs in job failure alerts", () => {
    const msg = renderMessage(
      delivery("job.run.failed", {
        eventType: "job_run.failed",
        jobName: "Audit unconfigured backups",
        exitCode: 1,
        errorMessage: "Command exited with code 1",
        durationMs: 2500,
        resourceType: "job",
        resourceId: "custom:BlS_iYp2_kUnHTbj",
        logExcerpt: "ALERT: Found 1 project(s) without backup configuration!",
      }),
    );

    expect(msg.title).toBe("Job failed");
    expect(msg.body).toContain("Job: Audit unconfigured backups");
    expect(msg.body).toContain("Exit Code: 1");
    expect(msg.body).toContain("Error: Command exited with code 1");
    expect(msg.body).toContain("Duration: 3s");
    expect(msg.body).toContain("Resource: job (custom:BlS_iYp2_kUnHTbj)");
    expect(msg.body).toContain("Logs:\nALERT: Found 1 project(s) without backup configuration!");
  });

  it("renders job name and exit code 0 for successful job runs", () => {
    const msg = renderMessage(
      delivery("job.run.succeeded", {
        eventType: "job_run.succeeded",
        label: "Audit disk space",
        exitCode: 0,
        durationMs: 500,
        resourceType: "job",
        resourceId: "custom:t6GN81ItRPW_qAkX",
      }),
    );

    expect(msg.title).toBe("Job succeeded");
    expect(msg.body).toContain("Job: Audit disk space");
    expect(msg.body).toContain("Exit Code: 0");
    expect(msg.body).toContain("Duration: 1s");
    expect(msg.body).toContain("Resource: job (custom:t6GN81ItRPW_qAkX)");
  });
});

describe("renderEmailHtml", () => {
  it("keeps every current notification detail and leaves the plaintext message unchanged", () => {
    const notice = delivery("job.run.failed", {
      eventType: "job_run.failed",
      message: "The backup check failed.",
      projectName: "Production",
      serviceName: "postgres",
      policyName: "Nightly",
      destinationName: "Offsite",
      jobName: "Backup check",
      branch: "main",
      commitSha: "123456789abcdef",
      url: "https://example.com/jobs?run=1&view=logs",
      exitCode: 0,
      errorMessage: "Failed <check>\n  at worker:4",
      durationMs: 0,
      resourceType: "job",
      resourceId: "job_1",
      logExcerpt: "\n  last log line <end>  \n",
    });
    expect(renderMessage(notice).body).toBe(
      [
        "A scheduled or manual job run errored out. Includes the job + exit code.",
        "The backup check failed.",
        "Project: Production",
        "Service: postgres",
        "Policy: Nightly",
        "Destination: Offsite",
        "Job: Backup check",
        "Branch: main",
        "Commit: 12345678",
        "URL: https://example.com/jobs?run=1&view=logs",
        "Exit Code: 0",
        "Error: Failed <check>\n  at worker:4",
        "Duration: 0s",
        "Resource: job (job_1)",
        "Logs:\nlast log line <end>",
      ].join("\n"),
    );
    const html = renderEmailHtml(notice);
    for (const detail of [
      "Production",
      "postgres",
      "Nightly",
      "Offsite",
      "Backup check",
      "main",
      "12345678",
      "Exit Code:",
      "Duration:",
      "0s",
      "job (job_1)",
    ]) {
      expect(html).toContain(detail);
    }
    expect(html).toContain('href="https://example.com/jobs?run=1&amp;view=logs"');
    expect(html).toMatch(/<pre[^>]*>Failed &lt;check&gt;\n  at worker:4<\/pre>/);
    expect(html).toMatch(/<pre[^>]*>last log line &lt;end&gt;<\/pre>/);
    expect(html.indexOf("Resource:")).toBeLessThan(html.indexOf("<pre"));
  });

  it("preserves backup references and job labels when display names are missing", () => {
    const html = renderEmailHtml(
      delivery("backup.failed", {
        policyId: "pol_1",
        destinationId: "dst_1",
        label: "Scheduled task",
      }),
    );
    expect(html).toContain("pol_1");
    expect(html).toContain("dst_1");
    expect(html).toContain("Scheduled task");
  });

  it("renders log-only job output in its own block", () => {
    const html = renderEmailHtml(
      delivery("job.run.succeeded", { logExcerpt: "  everything passed\nnext line  " }),
    );
    expect(html).toMatch(/<pre[^>]*>everything passed\nnext line<\/pre>/);
    expect(html).not.toContain("Error / Logs:");
  });

  it("escapes headings, metadata, messages and log contents", () => {
    const html = renderEmailHtml(
      delivery('<img src=x onerror="alert(1)">', {
        message: "<script>alert('message')</script>",
        projectName: '<svg onload="alert(1)">',
        errorMessage: "</pre><script>alert('error')</script>",
        logExcerpt: "<b>raw log & output</b>",
      }),
    );
    expect(html).not.toMatch(/<script|<img|<svg/);
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;svg");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;raw log &amp; output&lt;/b&gt;");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//example.com/path",
    "not a URL",
  ])("keeps an unsafe or invalid URL as text: %s", (url) => {
    const html = renderEmailHtml(delivery("deploy.failed", { url }));
    expect(html).not.toContain("<a ");
    expect(html).toContain("URL:");
  });

  it.each(["http://192.0.2.1:3000/health", "https://example.com/health"])(
    "links a valid application URL: %s",
    (url) => {
      expect(renderEmailHtml(delivery("service.recovered", { url }))).toContain(`href="${url}"`);
    },
  );

  it("uses the recovery headline and description in every format", () => {
    const notice = delivery("server.unreachable", {
      eventType: "server.reachable",
      message: "The server is back.",
    });
    const html = renderEmailHtml(notice);
    expect(html).toContain(renderMessage(notice).title);
    expect(html).toContain("The server is back.");
    expect(html).not.toContain("Server unreachable");
    expect(html).not.toContain("can't reach");
  });

  it("renders a queued notice with no payload without empty tables or log blocks", () => {
    const notice = {
      category: "service.recovered",
      payload: null,
    } as unknown as NotificationDelivery;
    const html = renderEmailHtml(notice);
    expect(html).toContain("App recovered");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("<table");
  });

  it("renders metadata and puts logs in a monospace pre block", () => {
    const html = renderEmailHtml(
      delivery("service.unhealthy", {
        eventType: "service.unhealthy",
        message: '"TimeTracker / app" is unhealthy — its healthcheck reports unhealthy.',
        url: "https://rechenkaiser.opsh.io/projects/proj_123/health",
        errorMessage: '127.0.0.1 - - [23/Sep/2026] "GET /_health" 429\nratelimit exceeded',
        resourceId: "proj_123",
        resourceType: "project",
      }),
    );

    expect(html).toContain("App unhealthy");
    expect(html).toContain("TimeTracker / app");
    expect(html).toContain("https://rechenkaiser.opsh.io/projects/proj_123/health");
    expect(html).toContain("<pre");
    expect(html).toContain("ui-monospace");
    expect(html).toContain("ratelimit exceeded");
    expect(html).toContain("Error / Logs:");
  });
});
