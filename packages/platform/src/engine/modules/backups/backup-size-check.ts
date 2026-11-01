import type { BackupRun } from "@repo/db";

interface SizedArtifact {
  name: string;
  payloadKind: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

/** A last-resort sanity check, not a substitute for the producer's exit status.
 * Compare full artifact bytes (never incremental uploaded bytes), and only the
 * same database / format / codec. A policy or compression change is not data loss.
 */
export function assertPlausibleBackupSizes(
  artifacts: SizedArtifact[],
  recent: Pick<BackupRun, "id" | "artifacts">[],
): void {
  for (const artifact of artifacts) {
    if (artifact.payloadKind !== "pg_dump" || typeof artifact.metadata.postgresDb !== "string")
      continue;
    const sizes: number[] = [];
    for (const run of recent) {
      const previous = run.artifacts?.find((value) => {
        if (!value || typeof value !== "object") return false;
        const candidate = value as Partial<SizedArtifact>;
        return (
          candidate.payloadKind === "pg_dump" &&
          candidate.name === artifact.name &&
          typeof candidate.sizeBytes === "number" &&
          Number.isFinite(candidate.sizeBytes) &&
          candidate.sizeBytes > 0 &&
          ["postgresDb", "format", "compression"].every(
            (key) => candidate.metadata?.[key] === artifact.metadata[key],
          )
        );
      }) as SizedArtifact | undefined;
      if (previous) sizes.push(previous.sizeBytes);
    }
    if (sizes.length === 0) continue;
    sizes.sort((a, b) => a - b);
    const middle = Math.floor(sizes.length / 2);
    const median = sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2;
    // Reject a >99% collapse. Ordinary changes and compression variation remain
    // valid; the reported 8 MB dump against ~1.26 GB history does not.
    if (artifact.sizeBytes < median * 0.01) {
      throw new Error(
        `PostgreSQL backup ${artifact.name} is only ${artifact.sizeBytes} bytes, below 1% of ` +
          `the recent successful median (${median} bytes). Refusing a potentially truncated backup; ` +
          `verify the source database before retrying.`,
      );
    }
  }
}
