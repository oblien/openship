import type { DeploymentAdapter, DeploymentConfig, DeploymentResult, BuildLog } from "./base-adapter";

/**
 * Oblien adapter — used for cloud-managed deployments.
 *
 * Communicates with the Oblien infrastructure API to provision and manage
 * containers/VMs for paying cloud users. This adapter is what makes the
 * hosted SaaS version work.
 */
export class OblienAdapter implements DeploymentAdapter {
  readonly name = "oblien";

  constructor(private apiUrl: string, private apiKey: string) {}

  async deploy(config: DeploymentConfig): Promise<DeploymentResult> {
    // TODO: Call Oblien API to create deployment
    return {
      id: `oblien-${Date.now()}`,
      url: `https://${config.projectId}.openship.cloud`,
      status: "queued",
    };
  }

  async getStatus(deploymentId: string): Promise<DeploymentResult> {
    // TODO: Query Oblien API
    return { id: deploymentId, url: "", status: "ready" };
  }

  async getLogs(deploymentId: string): Promise<BuildLog[]> {
    // TODO: Fetch logs from Oblien
    return [];
  }

  async cancel(deploymentId: string): Promise<void> {
    // TODO: Cancel via Oblien API
  }

  async rollback(deploymentId: string): Promise<DeploymentResult> {
    // TODO: Rollback via Oblien API
    return { id: deploymentId, url: "", status: "ready" };
  }

  async destroy(deploymentId: string): Promise<void> {
    // TODO: Destroy via Oblien API
  }
}
