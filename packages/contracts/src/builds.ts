import type { Static } from "@sinclair/typebox";
import { PrepareDeployBody, type TBuildAccessBody } from "./deployment-inputs";
import type { CreateDeploymentResult } from "./deployments";

export type PrepareDeploymentInput = Static<typeof PrepareDeployBody>;
export type BuildAccessInput = TBuildAccessBody;
export interface PreparedProject {
  stack: string;
  projectType: string;
  packageManager: string;
  buildCommand: string;
  startCommand: string;
  repository: { name: string; [key: string]: unknown };
  [key: string]: unknown;
}
export interface BuildOperations {
  prepare(input: PrepareDeploymentInput): Promise<PreparedProject>;
  buildAccess(input: BuildAccessInput): Promise<CreateDeploymentResult>;
  start(id: string): Promise<CreateDeploymentResult>;
}
