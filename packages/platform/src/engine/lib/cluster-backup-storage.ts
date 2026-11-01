import { AppError, type ClusterDatabaseRestoreSource } from "@repo/core";
import { repos } from "@repo/db";
import type { ClusterDatabaseBackupStorage } from "@repo/adapters";
import type { ExecutionContext } from "../../context";
import { assertResourceInOrg } from "./resource-access";
import { decryptSecretField } from "./credential-encryption";

export async function resolveClusterBackupStorage(
  ctx: ExecutionContext,
  destinationId: string,
  restore?: ClusterDatabaseRestoreSource,
): Promise<ClusterDatabaseBackupStorage> {
  const destination = await repos.backupDestination.findById(destinationId);
  assertResourceInOrg(destination, "Backup destination", ctx.organizationId, destinationId);
  const accessKeyId = decryptSecretField(destination.accessKeyIdEnc),
    secretAccessKey = decryptSecretField(destination.secretAccessKeyEnc);
  if (
    destination.kind !== "s3_compatible" ||
    !destination.bucket ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(destination.bucket) ||
    !accessKeyId ||
    !secretAccessKey
  )
    throw new AppError(
      "Choose an S3 backup destination with a bucket and access credentials.",
      422,
      "CLUSTER_DATABASE_BACKUP_DESTINATION",
    );
  if (destination.endpoint) {
    const url = new URL(destination.endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new AppError(
        "The S3 endpoint must be an HTTP or HTTPS address without embedded credentials or query parameters.",
        422,
        "CLUSTER_DATABASE_BACKUP_DESTINATION",
      );
  }
  const prefix = (destination.pathPrefix ?? "").replace(/^\/+|\/+$/g, "");
  if (/[\x00-\x1f\x7f]/.test(prefix) || prefix.split("/").includes(".."))
    throw new AppError(
      "The backup destination prefix contains an unsupported path.",
      422,
      "CLUSTER_DATABASE_BACKUP_DESTINATION",
    );
  const path = `s3://${destination.bucket}/${prefix ? `${prefix}/` : ""}${restore?.format === "backup-artifact" ? "" : "openship/databases"}`;
  if (restore && (restore.destinationPath !== path || restore.endpoint !== destination.endpoint))
    throw new AppError(
      "The original backup destination address changed. Restore its saved address before recovering this database.",
      409,
      "CLUSTER_DATABASE_BACKUP_DESTINATION",
    );
  return {
    destinationId,
    accessKeyId,
    secretAccessKey,
    endpoint: destination.endpoint,
    region: destination.region || "us-east-1",
    destinationPath: restore?.destinationPath ?? path,
  };
}
