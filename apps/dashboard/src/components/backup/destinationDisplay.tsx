import React from "react";
import { Cloud, Server, HardDrive } from "lucide-react";
import type { BackupDestinationSummary } from "@/lib/api";

/** Shared destination presentation — kept in one place so the list page and the
 *  detail page render kinds, connection strings, and credential summaries
 *  identically (no duplicated switch statements drifting apart). */

export const KIND_ICONS: Record<
  BackupDestinationSummary["kind"],
  React.ComponentType<{ className?: string }>
> = {
  s3_compatible: Cloud,
  sftp: Server,
  openship_server: Server,
  local: HardDrive,
  http_upload: Cloud,
};

// Kinds the create/edit form can configure. Others (e.g. http_upload) exist via
// the API but must NOT offer "Edit" — the form has no UI for them.
export const EDITABLE_KINDS = new Set<BackupDestinationSummary["kind"]>([
  "s3_compatible",
  "sftp",
  "openship_server",
]);

type BackupsDict = Record<string, string>;

export function kindLabel(kind: BackupDestinationSummary["kind"], m: BackupsDict): string {
  const map: Record<BackupDestinationSummary["kind"], string> = {
    s3_compatible: m.kindS3,
    sftp: m.kindSftp,
    openship_server: m.kindServer,
    local: m.kindLocal,
    http_upload: m.kindHttp,
  };
  return map[kind];
}

export function describeCredentials(row: BackupDestinationSummary, m: BackupsDict): string {
  switch (row.kind) {
    case "s3_compatible":
      return row.hasAccessKeyId && row.hasSecretAccessKey ? m.credAccessKeyStored : m.credNone;
    case "sftp":
      return row.hasSftpPrivateKey
        ? m.credPrivateKeyStored
        : row.hasSftpPassword
          ? m.credPasswordStored
          : m.credNone;
    case "openship_server":
      return m.credReusesServer;
    case "local":
      return m.credNoneNeeded;
    case "http_upload":
      return "—";
  }
}

export function describeDestination(row: BackupDestinationSummary, m: BackupsDict): string {
  switch (row.kind) {
    case "s3_compatible":
      return `${row.bucket ?? "?"}${row.region ? ` · ${row.region}` : ""}${row.endpoint ? ` · ${row.endpoint}` : ""}`;
    case "sftp":
      return `${row.sshUser ?? "?"}@${row.sshHost ?? "?"}:${row.sshPort ?? 22}${row.pathPrefix ? `:${row.pathPrefix}` : ""}`;
    case "openship_server":
      return `${m.serverPrefix}${row.serverId?.slice(0, 8) ?? "?"}…${row.pathPrefix ? ` · ${row.pathPrefix}` : ""}`;
    case "local":
      return row.endpoint ?? "?";
    case "http_upload":
      return row.endpoint ?? "?";
  }
}
