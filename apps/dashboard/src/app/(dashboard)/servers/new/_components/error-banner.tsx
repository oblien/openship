import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";

export function ErrorBanner({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <div className="mb-4 rounded-xl border border-danger-border bg-danger-bg p-4 flex items-start gap-3">
      <UiIcon name="x-circle" className="size-5 text-danger shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-medium text-foreground">{t.servers.setup.connectionFailed}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{message}</p>
      </div>
    </div>
  );
}
