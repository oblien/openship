/** Keep placeholder rows aligned with the server list's container-based layout. */
export function ServerListSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      <div aria-hidden="true" className="divide-y divide-border/50 motion-safe:animate-pulse">
        {["w-32", "w-40", "w-28", "w-36"].map((width) => (
          <div key={width} className="@container flex items-center pe-3">
            <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4 py-3 @xl:flex @xl:gap-3.5 @xl:px-5">
              <div className="size-9 shrink-0 rounded-xl bg-foreground/10" />
              <div className="min-w-0 @xl:w-44 @xl:shrink-0 @3xl:w-56">
                <div className="flex h-5 items-center">
                  <div className={`h-3.5 max-w-full rounded bg-foreground/10 ${width}`} />
                </div>
                <div className="mt-0.5 flex h-5 items-center">
                  <div className="h-3 w-24 max-w-full rounded bg-foreground/5" />
                </div>
              </div>
              <div className="col-span-2 flex min-w-0 flex-1 items-center gap-2 @xl:gap-3">
                <div className="h-5 w-20 rounded-md bg-foreground/5" />
              </div>
              <div className="col-span-2 flex shrink-0 items-center gap-4">
                <div className="flex h-5 items-center gap-1.5">
                  <div className="size-2.5 rounded-full bg-foreground/10" />
                  <div className="h-3 w-12 rounded bg-foreground/10" />
                </div>
                <div className="size-4 rounded bg-foreground/5" />
              </div>
            </div>
            <div className="flex size-8 shrink-0 items-center justify-center">
              <div className="size-4 rounded bg-foreground/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
