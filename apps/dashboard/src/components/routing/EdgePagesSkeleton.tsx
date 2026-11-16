import { useI18n } from "@/components/i18n-provider";

function Placeholder({ className }: { className: string }) {
  return (
    <div
      className={`max-w-full rounded-lg bg-foreground/[0.07] motion-safe:animate-pulse ${className}`}
    />
  );
}

/** Match the editor's sections instead of pulsing an empty card surface. */
export function EdgePagesSkeleton({ server = false }: { server?: boolean }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" className="space-y-4">
      <p className="text-sm text-muted-foreground">{t.widgets.routing.pages.loading}</p>
      <div aria-hidden="true" className="space-y-4">
        {!server && (
          <>
            <Placeholder className="h-10 w-64" />
            <div className="space-y-3 rounded-2xl bg-card p-5">
              <div className="flex items-center justify-between gap-5">
                <Placeholder className="h-5 w-40" />
                <Placeholder className="h-6 w-10 shrink-0 rounded-full" />
              </div>
              <Placeholder className="h-3 w-3/4" />
            </div>
          </>
        )}
        {["files", "errors"].map((section) => (
          <div key={section} className="space-y-4 rounded-2xl bg-card p-5">
            <div className="flex items-center justify-between gap-5">
              <Placeholder className="h-5 w-28" />
              <Placeholder className="h-8 w-24 shrink-0 rounded-xl" />
            </div>
            <Placeholder className="h-3 w-2/3" />
            <Placeholder className="h-10 w-full rounded-xl" />
          </div>
        ))}
        {server && (
          <div className="space-y-4 rounded-2xl bg-card p-5">
            <Placeholder className="h-5 w-44" />
            <Placeholder className="h-3 w-3/4" />
            <Placeholder className="h-10 w-full rounded-xl" />
          </div>
        )}
      </div>
    </div>
  );
}
