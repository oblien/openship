import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/providers/query-provider";
import { Button } from "@/components/ui/button";
import { SidebarToggle } from "@/components/ui/sidebar-toggle";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronLeft, ChevronRight } from "@/components/icons/icons";
import { MailIcon } from "@/components/icons/mail-icons";
import { EmptyStateIcon } from "@/components/icons/empty-state-svg";
import { ScheduledMessage } from "@/components/mail/scheduled-message";
import { cn } from "@/lib/utils";

export default function ScheduledPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"upcoming" | "history">("upcoming");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const jobs = useQuery(trpc.outbox.list.queryOptions({ offset, view }, { refetchInterval: 5000 }));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.outbox.pathKey() });
  };
  // Removing the last item on a page should take the user back to existing items.
  useEffect(() => {
    if (jobs.isSuccess && !jobs.data.items.length && offset > 0) {
      setOffset((value) => Math.max(0, value - 20));
    }
  }, [jobs.isSuccess, jobs.data, offset]);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll("_", " ");
  return (
    <div className="h-dvh w-full md:p-1 md:pl-0">
      <section
        aria-label="Scheduled mail"
        className="bg-panelLight dark:bg-panelDark flex h-full min-w-0 flex-col overflow-hidden shadow-sm md:rounded-2xl"
      >
        <header className="flex h-16 shrink-0 items-center gap-3 px-3 sm:px-4">
          <SidebarToggle />
          <h1 className="text-base font-medium">Scheduled</h1>
          <Button
            variant="ghost"
            size="icon"
            className="text-iconLight dark:text-iconDark ml-auto size-9"
            aria-label="Refresh scheduled mail"
            title="Refresh"
            disabled={jobs.isFetching}
            onClick={refresh}
          >
            <MailIcon name="refresh" className={cn(jobs.isFetching && "animate-spin")} />
          </Button>
        </header>
        <Tabs
          value={view}
          onValueChange={(value) => {
            setView(value as typeof view);
            setOffset(0);
            setSelected(null);
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/40 px-4 pb-3 sm:px-5">
            <TabsList className="h-9 gap-1 bg-primary/5 p-1">
              <TabsTrigger
                value="upcoming"
                className="h-7 px-3 text-[13px] data-[state=active]:bg-panelLight dark:data-[state=active]:bg-panelDark"
              >
                Upcoming
              </TabsTrigger>
              <TabsTrigger
                value="history"
                className="h-7 px-3 text-[13px] data-[state=active]:bg-panelLight dark:data-[state=active]:bg-panelDark"
              >
                History
              </TabsTrigger>
            </TabsList>
            <span
              className="text-muted-foreground flex items-center gap-1.5 text-xs"
              title="Your local time zone"
            >
              <MailIcon name="clock" className="size-3.5" />
              {timezone}
            </span>
          </div>
          <TabsContent
            value={view}
            className="m-0 min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-3"
          >
            {jobs.isPending ? (
              <div role="status" aria-label="Loading scheduled mail" className="space-y-2 p-2">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className="h-20 rounded-xl bg-primary/5" />
                ))}
              </div>
            ) : jobs.isError ? (
              <div
                role="alert"
                className="flex min-h-60 flex-col items-center justify-center gap-3 p-6 text-center"
              >
                <p className="text-sm">Could not load scheduled mail.</p>
                <Button variant="ghost" size="sm" onClick={refresh}>
                  Try again
                </Button>
              </div>
            ) : jobs.data.items.length === 0 ? (
              <div className="flex min-h-full flex-col items-center justify-center gap-4 px-4 py-12 text-center">
                <EmptyStateIcon width={150} height={150} />
                <div className="max-w-xs space-y-2">
                  <h2 className="text-base font-medium">
                    {view === "upcoming" ? "Nothing scheduled" : "No history yet"}
                  </h2>
                  <p className="text-muted-foreground text-[13px] leading-relaxed">
                    {view === "upcoming"
                      ? "Choose Send later when writing an email. Assistant proposals appear here for your approval."
                      : "Sent and cancelled items will appear here."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {jobs.data.items.map((item) => (
                  <ScheduledMessage
                    key={item.id}
                    item={item}
                    open={selected === item.id}
                    onOpenChange={(open) => setSelected(open ? item.id : null)}
                    onChange={refresh}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
        {(offset > 0 || jobs.data?.hasMore) && (
          <footer className="flex shrink-0 items-center justify-between border-t border-border/40 px-4 py-2">
            <p className="text-muted-foreground text-xs" aria-live="polite">
              Page {offset / 20 + 1}
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Previous page"
                disabled={offset === 0 || jobs.isFetching}
                onClick={() => {
                  setSelected(null);
                  setOffset(Math.max(0, offset - 20));
                }}
              >
                <ChevronLeft className="fill-current" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Next page"
                disabled={!jobs.data?.hasMore || jobs.isFetching}
                onClick={() => {
                  setSelected(null);
                  setOffset(offset + 20);
                }}
              >
                <ChevronRight className="fill-current" />
              </Button>
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}
