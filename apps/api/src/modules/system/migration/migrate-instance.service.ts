/**
 * Keep the earlier migration endpoint disabled. Whole-instance cutover uses
 * /system/instance with an explicit confirmation and durable handoff; an old
 * client must not start that operation without reviewing the new requirements.
 */
import type { Context } from "hono";
import type { DomainChoice } from "./preflight.service";

export const SERVER_MIGRATION_UNAVAILABLE =
  "This earlier server-migration endpoint is unavailable. " +
  "Use Settings → Instance → Instance location to review and move this installation.";

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
