import { randomUUID } from "node:crypto";
import { repos } from "@repo/db";
import type { NotificationEmitInput } from "../../lib/notification-dispatcher";

const healthEvents = new Set(["service.down", "service.unhealthy", "service.crash_loop"]);
/** An incident/deployment is the durable identity; alert retries and escalation cannot duplicate it. */
export async function captureAssistantAutomationEvent(input: NotificationEmitInput) {
  const health = healthEvents.has(input.eventType);
  if (!health && input.eventType !== "deployment.failed") return;
  const incidentId =
    health && typeof input.payload?.incidentId === "string" ? input.payload.incidentId : null;
  const incident = incidentId ? await repos.serviceIncident.findById(incidentId) : null;
  const deployment =
    !health && input.resourceType === "deployment" && input.resourceId
      ? await repos.deployment.findById(input.resourceId)
      : null;
  if (
    health
      ? !incident || incident.organizationId !== input.organizationId || incident.status !== "open"
      : !deployment ||
        deployment.organizationId !== input.organizationId ||
        !["failed", "error"].includes(deployment.status)
  )
    return;
  const projectId = incident?.projectId ?? deployment?.projectId;
  if (!projectId) return;
  const project = await repos.project.findByIdInOrganization(projectId, input.organizationId);
  if (!project || project.disabledAt) return;
  const deploymentId = incident?.deploymentId ?? deployment?.id ?? project.activeDeploymentId;
  if (!deploymentId) return;
  const trigger = health ? "service.unhealthy" : "deployment.failed";
  const occurred = incident?.openedAt ?? deployment?.createdAt;
  for (const rule of await repos.assistantAutomations.candidates(
    input.organizationId,
    projectId,
    trigger,
  )) {
    if (occurred && occurred <= rule.armedAt) continue;
    if ((await repos.assistantAutomations.settings(rule))?.paused) continue;
    await repos.assistantAutomations.enqueue({
      id: randomUUID(),
      automationId: rule.id,
      userId: rule.userId,
      organizationId: rule.organizationId,
      projectId,
      revision: rule.revision,
      eventKey: `${health ? "incident" : "deployment"}:${incident?.id ?? deployment?.id}`,
      definition: { name: rule.name, mode: rule.mode, action: rule.action },
      deploymentId,
      incidentId,
    });
  }
}

/** The existing system-job scheduler owns timing. The API supplies its native assistant adapter. */
let sweep: (() => Promise<{ checked: number }>) | undefined;
export function registerAssistantAutomationWorker(worker?: typeof sweep) {
  sweep = worker;
}
export async function runAssistantAutomationSweep() {
  return sweep ? sweep() : { checked: 0 };
}
