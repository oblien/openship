import { and, eq, isNull } from "drizzle-orm";
import { AppError } from "@repo/core";
import type { Database } from "../client";
import { backupDestination } from "../schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Serialize new references with destination edits/deletion. */
export async function lockClusterBackupDestinations(
  tx: Transaction,
  org: string,
  ids: Array<string | undefined>,
) {
  for (const id of [...new Set(ids.filter((value): value is string => !!value))].sort()) {
    const [destination] = await tx
      .select()
      .from(backupDestination)
      .where(
        and(
          eq(backupDestination.id, id),
          eq(backupDestination.organizationId, org),
          isNull(backupDestination.deletedAt),
        ),
      )
      .for("update");
    if (
      !destination ||
      destination.kind !== "s3_compatible" ||
      !destination.bucket ||
      !destination.accessKeyIdEnc ||
      !destination.secretAccessKeyEnc
    )
      throw new AppError(
        "Choose an available backup destination with access credentials.",
        409,
        "CLUSTER_BACKUP_DESTINATION",
      );
  }
}
