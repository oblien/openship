/** Terminal rendering; decoding and deployment outcome handling belong to the SDK. */
import { consumeDeploymentEvents, type DeploymentStreamResult } from "@repo/sdk/client";
import { getShipClient } from "./ship-client";
import { isJsonMode, info, ok, err } from "./output";

export type StreamResult = DeploymentStreamResult;

export async function streamDeploymentLogs(deploymentId: string): Promise<StreamResult> {
  const client = getShipClient();
  const result = await consumeDeploymentEvents(client.deployments.events(deploymentId), (event) => {
    if (event.event === "ping") return;
    if (isJsonMode()) {
      process.stdout.write(JSON.stringify({ event: event.event, ...event.payload, ...(event.log !== undefined && { message: event.log }) }) + "\n");
    } else if (event.log) {
      process.stdout.write(event.log);
    } else if (event.event === "prompt") {
      info(`\n${String(event.payload.title ?? "Deployment needs a decision")}: ${String(event.payload.message ?? "")}`);
      info(`Inspect it with openship deployment pending ${deploymentId}, then respond with openship deployment respond ${deploymentId} --action <action>.`);
    }
  });

  if (!result.completed && !isJsonMode()) info("Event stream ended; checking deployment status…");
  const outcome = await client.deployment(deploymentId).wait();
  result.status = outcome.status;
  result.success = outcome.success;
  result.message = outcome.message ?? result.message;
  result.warning = outcome.warning ?? result.warning;
  if (isJsonMode()) {
    process.stdout.write(JSON.stringify({ event: "outcome", ...outcome }) + "\n");
  } else if (result.failedServices?.length) {
    const names = result.failedServices.map((service) => service.name).join(", ");
    const ids = result.failedServices.map((service) => service.id).join(",");
    err(`\n⚠ ${result.failedServices.length} of ${result.serviceCount} service(s) failed: ${names}\n` +
      `Retry the failed services with openship deploy --service-ids ${ids}\n`);
  } else if (outcome.prompt) {
    info(`\n${outcome.prompt.title}: ${outcome.prompt.message}`);
  } else if (result.success) {
    ok(`\n✓ ${result.message ?? (outcome.status === "no_changes" ? "No deployment changes" : "Deployment ready")}`);
    if (result.warning) info(result.warning);
  } else {
    err(`\n✗ ${result.message ?? `Deployment ${outcome.status}`}`);
  }
  return result;
}
