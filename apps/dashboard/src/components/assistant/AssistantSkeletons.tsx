import { cn } from "@/lib/utils";

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("block rounded-md bg-foreground/[0.07] motion-safe:animate-pulse", className)}
    />
  );
}

export function AssistantListSkeleton({
  label = "Loading agents",
  count = 3,
}: {
  label?: string;
  count?: number;
}) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="space-y-2">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-3 py-4">
          <SkeletonBlock className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonBlock className={index % 2 ? "h-3.5 w-2/3" : "h-3.5 w-3/4"} />
            <SkeletonBlock className="h-2.5 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ConversationSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading conversation"
      aria-busy="true"
      className="mx-auto w-full max-w-3xl space-y-10 px-1 py-6"
    >
      <SkeletonBlock className="ms-auto h-14 w-2/3 rounded-3xl" />
      <div className="space-y-3 py-2">
        <SkeletonBlock className="h-3 w-11/12" />
        <SkeletonBlock className="h-3 w-full" />
        <SkeletonBlock className="h-3 w-4/5" />
        <SkeletonBlock className="h-3 w-1/2" />
      </div>
    </div>
  );
}

export function AssistantWorkspaceSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 gap-5 xl:gap-7" data-assistant-skeleton="workspace">
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          role="status"
          aria-label="Loading AI Agents"
          aria-busy="true"
          className="mb-5 flex h-10 items-center gap-3"
        >
          <SkeletonBlock className="h-5 w-44" />
          <SkeletonBlock className="ms-auto h-8 w-20 rounded-xl" />
        </div>
        <ConversationSkeleton />
        <SkeletonBlock className="mx-auto mt-auto h-36 w-full max-w-3xl shrink-0 rounded-3xl" />
      </div>
      <aside
        aria-label="Loading navigation"
        className="hidden w-[340px] shrink-0 border-s border-border/40 ps-4 lg:block xl:ps-5"
      >
        <SkeletonBlock className="mb-7 mt-3 h-4 w-28" />
        <SkeletonBlock className="mb-5 h-10 w-full rounded-xl" />
        <AssistantListSkeleton />
      </aside>
    </div>
  );
}

export function AgentEditorSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading agent settings"
      aria-busy="true"
      className="space-y-8 p-6 pt-8 sm:p-8"
    >
      <SkeletonBlock className="h-4 w-24" />
      <div className="space-y-3">
        <SkeletonBlock className="h-7 w-52" />
        <SkeletonBlock className="h-3 w-2/3" />
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-6">
          {[0, 1, 2].map((index) => (
            <div key={index} className="space-y-3">
              <SkeletonBlock className="h-3 w-32" />
              <SkeletonBlock className={cn("w-full rounded-xl", index === 2 ? "h-32" : "h-11")} />
            </div>
          ))}
        </div>
        <div className="space-y-4 rounded-2xl bg-card p-5">
          <SkeletonBlock className="h-5 w-36" />
          <SkeletonBlock className="h-3 w-4/5" />
          <AssistantListSkeleton label="Loading agent access" />
        </div>
      </div>
    </div>
  );
}
