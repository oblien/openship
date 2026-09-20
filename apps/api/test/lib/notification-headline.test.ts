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

import { renderMessage } from "@repo/platform/engine/lib/notification-workers";

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
