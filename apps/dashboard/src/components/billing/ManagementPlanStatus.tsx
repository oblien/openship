import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

export function ManagementPlanStatus({ pending, error, onRetry, showConnectionHint = false }: {
  pending: boolean;
  error: string | null;
  onRetry: () => void;
  showConnectionHint?: boolean;
}) {
  const { t } = useI18n();
  const copy = t.billing.managementPlans;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/50 bg-card px-4 py-3.5">
      <span aria-hidden="true" className={`grid size-9 shrink-0 place-items-center rounded-xl ${pending ? "bg-info-bg text-info" : "bg-warning-bg text-warning"}`}>
        {pending
          ? <span className="size-4 rounded-full border-2 border-info/25 border-t-info motion-safe:animate-spin" />
          : <Icon name="alert-circle" className="size-4" />}
      </span>
      <div role={pending ? "status" : "alert"} className="min-w-0 flex-1 basis-44">
        <p className="text-sm font-medium text-foreground">
          {pending ? copy.checkingAccess : copy.accessUnavailable}
        </p>
        {pending ? showConnectionHint && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{copy.checkingAccessHint}</p>
        ) : error && (
          <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{error}</p>
        )}
      </div>
      {!pending && (
        <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
          <Icon name="refresh" className="size-3.5" aria-hidden="true" />
          {t.billing.plansRoute.tryAgain}
        </Button>
      )}
    </div>
  );
}
