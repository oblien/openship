import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@zero/server/trpc";
import { format } from "date-fns";
import { toast } from "sonner";
import { useTRPC } from "@/providers/query-provider";
import { renderSanitizedMailHtml } from "@/lib/mail-html";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThreeDots, Trash, X } from "@/components/icons/icons";
import { MailIcon } from "@/components/icons/mail-icons";

type ScheduledItem = inferRouterOutputs<AppRouter>["outbox"]["list"]["items"][number];

const stateLabels = {
  approval: "Needs approval",
  pending: "Scheduled",
  running: "Processing",
  done: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  uncertain: "Check delivery",
};

export function ScheduledMessage({
  item,
  open,
  onOpenChange,
  onChange,
}: {
  item: ScheduledItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: () => void;
}) {
  const trpc = useTRPC();
  const detailsId = useId();
  const [editing, setEditing] = useState(false);
  const [at, setAt] = useState("");
  const callbacks = {
    onSuccess: onChange,
    onError: (e: { message: string }) => toast.error(e.message),
  };
  const cancel = useMutation(trpc.outbox.cancel.mutationOptions(callbacks));
  const remove = useMutation(trpc.outbox.remove.mutationOptions(callbacks));
  const reschedule = useMutation(
    trpc.outbox.reschedule.mutationOptions({
      ...callbacks,
      onSuccess: () => {
        setEditing(false);
        onChange();
      },
    }),
  );
  const busy = cancel.isPending || remove.isPending || reschedule.isPending;
  const canCancel = item.kind === "send" && ["pending", "approval"].includes(item.state);
  const canReschedule = item.kind === "send" && item.state === "pending" && !item.grantId;
  const canRemove = ["done", "cancelled", "failed", "uncertain"].includes(item.state);
  const archived = item.state === "done" || item.state === "cancelled";
  const date = new Date(archived ? item.updatedAt : item.dueAt);
  const subject = item.subject || "(No subject)";
  const status = item.state === "done" && item.kind === "send" ? "Sent" : stateLabels[item.state];
  return (
    <article className="py-1">
      <div
        className={cn("rounded-xl transition-colors", open ? "bg-primary/5" : "hover:bg-primary/5")}
      >
        <div className="flex items-center gap-1 pr-2">
          <button
            type="button"
            aria-label={`${open ? "Close" : "Review"} ${subject}`}
            aria-expanded={open}
            aria-controls={detailsId}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-4 sm:p-4"
            onClick={() => onOpenChange(!open)}
          >
            <span className="text-iconLight dark:text-iconDark flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/5">
              <MailIcon
                name={item.grantId ? "assistant" : archived ? "mail" : "scheduled"}
                className="size-5"
              />
            </span>
            <span className="min-w-0 flex-1 sm:flex sm:items-center sm:justify-between sm:gap-6">
              <span className="block min-w-0 space-y-1">
                <span className="block truncate text-sm font-medium">{subject}</span>
                <span className="text-muted-foreground block truncate text-[13px]">
                  {item.to.join(", ") || "Returns to your inbox"}
                </span>
              </span>
              <span className="text-muted-foreground mt-1 flex flex-wrap gap-x-2 text-xs sm:mt-0 sm:block sm:shrink-0 sm:space-y-1 sm:text-right">
                <span className={cn("block", item.state === "approval" && "text-foreground")}>
                  {status}
                </span>
                <time className="block" dateTime={date.toISOString()} title={date.toLocaleString()}>
                  {item.state === "approval" ? "Waiting for you" : format(date, "MMM d, h:mm a")}
                </time>
              </span>
            </span>
          </button>
          {(canCancel || canReschedule || canRemove) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-iconLight dark:text-iconDark size-8 shrink-0"
                  aria-label={`Actions for ${subject}`}
                  disabled={busy}
                >
                  <ThreeDots className="fill-current" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44 rounded-xl p-1.5">
                {canReschedule && (
                  <>
                    <DropdownMenuItem
                      onSelect={() => reschedule.mutate({ id: item.id, revision: item.revision })}
                    >
                      <MailIcon name="send" />
                      Send now
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setEditing(true);
                        setAt(
                          format(
                            new Date(Math.max(item.dueAt, Date.now() + 60_000)),
                            "yyyy-MM-dd'T'HH:mm",
                          ),
                        );
                        onOpenChange(true);
                      }}
                    >
                      <MailIcon name="scheduled" />
                      Change time
                    </DropdownMenuItem>
                  </>
                )}
                {canCancel && (
                  <DropdownMenuItem onSelect={() => cancel.mutate({ id: item.id })}>
                    <X className="fill-current" />
                    {item.state === "approval" ? "Decline proposal" : "Cancel send"}
                  </DropdownMenuItem>
                )}
                {canRemove && (
                  <DropdownMenuItem onSelect={() => remove.mutate({ id: item.id })}>
                    <Trash className="fill-current" />
                    Remove
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {item.error && (
          <p role="alert" className="text-muted-foreground px-4 pb-3 text-[13px] sm:pl-[4.25rem]">
            {item.error}
          </p>
        )}
        {open && (
          <div id={detailsId} className="space-y-4 px-4 pb-4 sm:pl-[4.25rem] sm:pr-5">
            {editing && canReschedule && (
              <form
                className="flex flex-wrap items-end gap-2 border-t border-border/40 pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  const date = new Date(at);
                  if (!Number.isFinite(date.getTime())) return;
                  reschedule.mutate({
                    id: item.id,
                    revision: item.revision,
                    at: date.toISOString(),
                  });
                }}
              >
                <label className="space-y-1.5 text-xs">
                  <span className="text-muted-foreground block">
                    Send time · {Intl.DateTimeFormat().resolvedOptions().timeZone}
                  </span>
                  <Input
                    type="datetime-local"
                    required
                    value={at}
                    onChange={(e) => setAt(e.target.value)}
                  />
                </label>
                <Button size="sm" disabled={busy}>
                  Save time
                </Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </form>
            )}
            <ReviewMessage id={item.id} revision={item.revision} onChange={onChange} />
          </div>
        )}
      </div>
    </article>
  );
}

function MessagePreview({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    renderSanitizedMailHtml(
      host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" }),
      html,
    );
  }, [html]);
  return <div ref={host} className="max-h-80 overflow-auto rounded-lg bg-white p-4" />;
}

function ReviewMessage({
  id,
  revision,
  onChange,
}: {
  id: string;
  revision: number;
  onChange: () => void;
}) {
  const trpc = useTRPC();
  const details = useQuery(trpc.outbox.get.queryOptions({ id }));
  const { refetch } = details;
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) {
      previousRevision.current = revision;
      void refetch();
    }
  }, [revision, refetch]);
  const approve = useMutation(
    trpc.outbox.approve.mutationOptions({
      onSuccess: () => {
        toast.success("Approved. You can still cancel before sending starts.");
        onChange();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (details.isPending)
    return (
      <p role="status" className="text-muted-foreground text-[13px]">
        Loading message…
      </p>
    );
  if (details.isError)
    return (
      <p role="alert" className="text-muted-foreground text-[13px]">
        {details.error.message}
      </p>
    );
  const item = details.data;
  if (!("message" in item.payload))
    return (
      <p className="text-muted-foreground text-[13px]">
        {item.payload.ids.length} snoozed messages
      </p>
    );
  const { from, message } = item.payload;
  return (
    <div className="space-y-4 border-t border-border/40 pt-4">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 break-words text-[13px]">
        <dt className="text-muted-foreground">From</dt>
        <dd>{from}</dd>
        {(
          [
            ["To", message.to],
            ["Cc", message.cc],
            ["Bcc", message.bcc],
          ] as const
        ).map(([label, values]) =>
          values?.length ? (
            <Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{values.join(", ")}</dd>
            </Fragment>
          ) : null,
        )}
      </dl>
      {item.previewHtml ? (
        <MessagePreview html={item.previewHtml} />
      ) : (
        <div className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
          {message.text || "(Empty message)"}
        </div>
      )}
      {!!message.attachments?.length && (
        <ul className="text-muted-foreground text-xs">
          {message.attachments.map((file, index) => (
            <li key={index}>
              {file.name} · {file.type}
            </li>
          ))}
        </ul>
      )}
      {item.state === "approval" && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-3">
          <p className="text-muted-foreground text-xs">
            {item.dueAt > Date.now()
              ? `Sends ${format(new Date(item.dueAt), "MMM d, h:mm a")}`
              : "Sends after approval, with 15 seconds to undo."}
          </p>
          <Button
            size="sm"
            disabled={approve.isPending}
            onClick={() => approve.mutate({ id, revision: item.revision })}
          >
            <MailIcon name="send" />
            {approve.isPending ? "Approving…" : "Approve send"}
          </Button>
        </div>
      )}
    </div>
  );
}
