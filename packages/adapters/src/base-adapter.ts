/**
 * Base adapter interface.
 *
 * Every deployment target (Docker, Oblien, AWS, etc.) must implement this contract.
 * This is the abstraction that makes Openship platform-agnostic.
 */

export interface DeploymentConfig {
  projectId: string;
  branch: string;
  commitSha?: string;
  environment: "production" | "preview";
  envVars?: Record<string, string>;
}

export interface DeploymentResult {
  id: string;
  url: string;
  status: "queued" | "building" | "deploying" | "ready" | "failed" | "cancelled";
}

export interface BuildLog {
  timestamp: string;
  message: string;
  level: "info" | "warn" | "error";
}

export interface DeploymentAdapter {
  /** Human-readable name of the adapter */
  readonly name: string;

  /** Deploy a project and return the deployment result */
  deploy(config: DeploymentConfig): Promise<DeploymentResult>;

  /** Get the current status of a deployment */
  getStatus(deploymentId: string): Promise<DeploymentResult>;

  /** Stream or fetch build/deploy logs */
  getLogs(deploymentId: string): Promise<BuildLog[]>;

  /** Cancel an in-progress deployment */
  cancel(deploymentId: string): Promise<void>;

  /** Rollback to a previous deployment */
  rollback(deploymentId: string): Promise<DeploymentResult>;

  /** Tear down / delete a deployment and its resources */
  destroy(deploymentId: string): Promise<void>;
}
