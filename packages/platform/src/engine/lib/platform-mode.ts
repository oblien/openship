import { env } from "../config/env";

export function isOblienConfigured(): boolean {
  return env.CLOUD_MODE || env.DEPLOY_MODE === "cloud";
}

export function isOblienBackedDeployment(deployTarget?: string | null): boolean {
  return isOblienConfigured() || deployTarget === "cloud";
}
