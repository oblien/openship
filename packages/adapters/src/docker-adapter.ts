import type { DeploymentAdapter, DeploymentConfig, DeploymentResult, BuildLog } from "./base-adapter";

/**
 * Docker adapter — used for self-hosted deployments.
 *
 * Builds and runs containers on the host machine using Docker Engine API.
 * This is the default adapter for open-source / self-hosted installations.
 */
export class DockerAdapter implements DeploymentAdapter {
  readonly name = "docker";

  async deploy(config: DeploymentConfig): Promise<DeploymentResult> {
    // TODO: Clone repo, docker build, docker run
    return {
      id: `docker-${Date.now()}`,
      url: `http://localhost:3000`,
      status: "queued",
    };
  }

  async getStatus(deploymentId: string): Promise<DeploymentResult> {
    // TODO: Inspect container status
    return { id: deploymentId, url: "", status: "ready" };
  }

  async getLogs(deploymentId: string): Promise<BuildLog[]> {
    // TODO: docker logs
    return [];
  }

  async cancel(deploymentId: string): Promise<void> {
    // TODO: docker stop
  }

  async rollback(deploymentId: string): Promise<DeploymentResult> {
    // TODO: Restart previous container
    return { id: deploymentId, url: "", status: "ready" };
  }

  async destroy(deploymentId: string): Promise<void> {
    // TODO: docker rm -f
  }
}
