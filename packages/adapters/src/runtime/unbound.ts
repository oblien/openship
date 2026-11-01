import { AppError } from "@repo/core";
import type { RuntimeAdapter, RuntimeCapability } from "./types";

/** A control plane has infrastructure access, but no implicit application host. */
export class UnboundRuntime implements RuntimeAdapter {
  readonly name = "unbound";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set();
  supports() { return false; }

  private async requireDestination(): Promise<never> {
    throw new AppError("Select a deployment server before managing an application", 409, "DEPLOYMENT_SERVER_REQUIRED");
  }

  build = this.requireDestination;
  cancelBuild = this.requireDestination;
  getBuildLogs = this.requireDestination;
  deploy = this.requireDestination;
  stop = this.requireDestination;
  start = this.requireDestination;
  restart = this.requireDestination;
  destroy = this.requireDestination;
  getContainerInfo = this.requireDestination;
  getRuntimeLogs = this.requireDestination;
  streamRuntimeLogs = this.requireDestination;
  getUsage = this.requireDestination;
  getContainerIp = this.requireDestination;
  archive = this.requireDestination;
  purge = this.requireDestination;
}
