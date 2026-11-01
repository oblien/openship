import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";

/** The same readable outcome on project history and destination policy rows. */
export function BackupStatusChip({ status }: { status: string }) {
  const { t } = useI18n();
  const labels = t.widgets.backup.runCard.status;
  const label =
    status === "server_error"
      ? labels.serverError
      : (labels[status as keyof typeof labels] ?? status);
  const success = status === "succeeded";
  const failure = status === "failed" || status === "server_error";
  const active = ["queued", "preparing", "snapshotting", "uploading", "verifying"].includes(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${success ? "text-success" : failure ? "text-danger" : active ? "text-info" : "text-muted-foreground"}`}
    >
      <Icon
        name={success ? "check-circle" : failure ? "x-circle" : active ? "spinner" : "circle"}
        className={`size-3 ${active ? "animate-spin" : ""}`}
      />
      {label}
    </span>
  );
}
