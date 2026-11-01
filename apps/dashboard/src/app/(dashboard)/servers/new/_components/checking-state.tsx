import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";

export function CheckingState() {
  const { t } = useI18n();
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-8">
      <div className="flex flex-col items-center justify-center py-8">
        <UiIcon name="spinner" className="size-8 text-primary animate-spin mb-4" />
        <p className="text-sm font-medium text-foreground">{t.servers.setup.connecting}</p>
        <p className="text-xs text-muted-foreground mt-1">
          {t.servers.setup.runningChecks}
        </p>
      </div>
    </div>
  );
}
