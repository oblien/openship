/**
 * Deployment service — orchestrates builds and deployments via adapters.
 */

export async function queueDeployment(projectId: string, opts: { branch?: string }) {
  // TODO: Create deployment record, push to BullMQ queue
}

export async function processDeployment(deploymentId: string) {
  // TODO: Pull adapter (Docker / Oblien), build, deploy
}

export async function getDeploymentLogs(deploymentId: string) {
  // TODO: Fetch logs from adapter or storage
}

export async function rollbackDeployment(deploymentId: string) {
  // TODO: Re-activate a previous deployment
}

export async function cancelDeployment(deploymentId: string) {
  // TODO: Signal adapter to stop build
}
