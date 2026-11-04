/** Mirrors the embedded access editor while its authorization is being prepared. */
export function PermissionReviewSkeleton() {
  const block = "rounded-lg bg-foreground/[0.07] motion-safe:animate-pulse";
  return (
    <div
      role="status"
      aria-label="Preparing your permissions"
      aria-busy="true"
      className="flex min-h-0 flex-1 flex-col p-6 sm:p-8"
    >
      <div aria-hidden="true" className="space-y-3 pb-8 pe-10">
        <div className={`${block} h-6 w-52 max-w-full`} />
        <div className={`${block} h-3 w-80 max-w-full`} />
      </div>
      <div
        aria-hidden="true"
        className="grid min-h-0 flex-1 gap-6 overflow-hidden sm:grid-cols-[1.3fr_1fr]"
      >
        <div className="space-y-4">
          {[0, 1, 2].map((item) => (
            <div key={item} className={`${block} h-24 w-full rounded-2xl`} />
          ))}
        </div>
        <div className="hidden rounded-2xl bg-card p-6 sm:block">
          <div className={`${block} mb-8 h-4 w-32`} />
          {[0, 1, 2].map((item) => (
            <div key={item} className="mb-7 space-y-3">
              <div className={`${block} h-3 w-3/4`} />
              <div className={`${block} h-2.5 w-1/2`} />
            </div>
          ))}
        </div>
      </div>
      <div aria-hidden="true" className="mt-6 flex justify-end gap-3">
        <div className={`${block} h-10 w-24`} />
        <div className={`${block} h-10 w-36`} />
      </div>
    </div>
  );
}
