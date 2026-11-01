import { Icon, type IconName } from "@repo/ui/icons";
import React from "react";
import type { BackupDestinationSummary } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";

/** Shared destination presentation — kept in one place so the list page and the
 *  detail page render kinds, connection strings, and credential summaries
 *  identically (no duplicated switch statements drifting apart). */

export const KIND_ICONS: Record<BackupDestinationSummary["kind"], IconName> = {
  s3_compatible: "cloud",
  sftp: "server",
  openship_server: "server",
  local: "hard-drive",
  http_upload: "cloud",
};

// Kinds the create/edit form can configure. Others (e.g. http_upload) exist via
// the API but must NOT offer "Edit" — the form has no UI for them.
export const EDITABLE_KINDS = new Set<BackupDestinationSummary["kind"]>([
  "s3_compatible",
  "sftp",
  "openship_server",
]);

type BackupsDict = Record<string, string>;

export function DestinationVerificationBadge({
  destination,
  verifying = false,
  badge = true,
}: {
  destination: BackupDestinationSummary;
  verifying?: boolean;
  badge?: boolean;
}) {
  const { t, locale } = useI18n();
  const m = t.misc.backups;
  // lastVerifiedAt deliberately survives a failed probe. The latest error wins.
  const failed = !!destination.lastVerifyError;
  const verified = !failed && !!destination.lastVerifiedAt;
  const color = verifying
    ? "text-muted-foreground"
    : failed
      ? "text-danger"
      : verified
        ? "text-success"
        : "text-muted-foreground";
  const background = verifying
    ? "bg-foreground/[0.06]"
    : failed
      ? "bg-danger-bg"
      : verified
        ? "bg-success-bg"
        : "bg-foreground/[0.04]";
  const title = verifying
    ? undefined
    : failed
      ? destination.lastVerifyError!
      : verified
        ? interpolate(m.lastVerified, {
            date: new Date(destination.lastVerifiedAt!).toLocaleString(locale),
          })
        : undefined;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${color} ${badge ? `rounded-full px-2 py-0.5 font-medium ${background}` : ""}`}
      title={title}
    >
      <Icon
        name={verifying ? "spinner" : failed ? "x-circle" : verified ? "check-circle" : "circle"}
        className={`size-3 ${verifying ? "animate-spin" : ""}`}
      />
      {verifying
        ? m.verifyingBadge
        : failed
          ? m.failedBadge
          : verified
            ? m.verifiedBadge
            : m.notVerifiedBadge}
    </span>
  );
}

export function BackupDestinationLoadError({
  error,
  retry,
  busy,
}: {
  error: unknown;
  retry: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger"
    >
      <span>{getApiErrorMessage(error, t.projectSettings.backup.overview.loadFailed)}</span>
      <button
        type="button"
        onClick={retry}
        disabled={busy}
        className="shrink-0 rounded-lg px-3 py-1.5 font-medium hover:bg-foreground/[0.06] disabled:opacity-50"
      >
        {t.chrome.apiDown.retry}
      </button>
    </div>
  );
}

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
