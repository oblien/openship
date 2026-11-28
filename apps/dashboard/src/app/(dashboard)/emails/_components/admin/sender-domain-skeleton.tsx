import { useI18n } from "@/components/i18n-provider";
import { Skeleton } from "./_shared/skeleton";

export function SenderDomainDetailSkeleton({ dns = false }: { dns?: boolean }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t.emailsAdmin.dns.loading} className="space-y-4">
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        {dns ? <h2 className="text-lg font-medium">{t.emailsAdmin.dns.heading}</h2> : <Skeleton className="h-4 w-40 max-w-full" />}
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      {dns ? (
        <div className="divide-y divide-border/60 border-y border-border/60">
          {[0, 1].map(i => <div key={i} className="flex h-12 items-center gap-3">
            <Skeleton className="h-5 w-10" /><Skeleton className="h-3 w-44 max-w-[55%]" />
          </div>)}
        </div>
      ) : <>
        <Skeleton className="h-8 w-32 rounded-xl" />
        <Skeleton className="my-1 h-3 w-20" />
      </>}
    </div>
  );
}
