/**
 * Whole-instance remote cutover is not implemented. The former orchestration
 * created a project row and attempted a destructive restore without deploying
 * or identifying a running target. Keep the boundary explicit until the shared
 * deployment engine owns provisioning, quiescence, restore and verified cutover.
 */
import type { Context } from "hono";
import type { DomainChoice } from "./preflight.service";

export const SERVER_MIGRATION_UNAVAILABLE =
  "Moving this installation to another server is unavailable in this version. " +
  "Use Settings → Data transfer to export, then import on a running target installation.";

export class ServerMigrationUnavailableError extends Error {
  readonly code = "SERVER_MIGRATION_UNAVAILABLE";
  constructor() {
    super(SERVER_MIGRATION_UNAVAILABLE);
    this.name = "ServerMigrationUnavailableError";
  }
}

export interface MigrateInstanceInput {
  serverId: string;
  domain: DomainChoice;
  organizationId: string;
  c: Context;
  userId: string;
}
export interface MigrateInstanceResult {
  projectId: string;
  groupId: string;
  migrationTargetUrl: string;
}

/** Fail before acquiring a lock, creating rows, exporting secrets or dialing SSH. */
export async function migrateInstanceToServer(
  _input: MigrateInstanceInput,
): Promise<MigrateInstanceResult> {
  throw new ServerMigrationUnavailableError();
}
