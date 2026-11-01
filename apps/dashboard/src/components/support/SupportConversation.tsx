"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CloudSupportCustomerDetail, CloudSupportCustomerReply } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useSupportApi } from "./support-api";
import { TicketStatus, TicketTime } from "./support-shared";

/** Mounted with a ticket/account key so late work cannot affect another conversation. */
export function SupportConversation({
  ticketId,
  onChanged,
}: {
  ticketId: string;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const cloudSupportApi = useSupportApi();
  const copy = t.support;
  const id = useId();
  const [detail, setDetail] = useState<CloudSupportCustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<"reply" | "status" | null>(null);
  const [pending, setPending] = useState<"reply" | "status" | null>(null);
  const [message, setMessage] = useState("");
  const attempt = useRef<CloudSupportCustomerReply | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const previous = useRef<CloudSupportCustomerDetail | null>(null);

  const load = useCallback(async () => {
    if (busy.current) return;
    const request = ++generation.current;
    try {
      const result = await cloudSupportApi.get(ticketId);
      if (!mounted.current || request !== generation.current) return;
      if (
        previous.current &&
        (previous.current.ticket.updatedAt !== result.ticket.updatedAt ||
          previous.current.ticket.status !== result.ticket.status)
      )
        onChanged();
      previous.current = result;
      setDetail(result);
      setLoadFailed(false);
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "dashboard/components/support/SupportConversation");
      if (mounted.current && request === generation.current) setLoadFailed(true);
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, [ticketId, onChanged, cloudSupportApi]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted.current = false;
      generation.current++;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  async function mutate(kind: "reply" | "status") {
    if (busy.current || !detail || (kind === "reply" && !message.trim())) return;
    busy.current = true;
    generation.current++; // A read started before this write must not overwrite its result.
    setPending(kind);
    setActionError(null);
    try {
      let result: CloudSupportCustomerDetail;
      if (kind === "reply") {
        const body = message.trim();
        if (attempt.current?.message !== body)
          attempt.current = { requestId: crypto.randomUUID(), message: body };
        result = await cloudSupportApi.reply(ticketId, attempt.current);
      } else {
        result = await cloudSupportApi.setStatus(
          ticketId,
          detail.ticket.status === "open" ? "resolved" : "open",
        );
      }
      if (!mounted.current) return;
      previous.current = result;
      setDetail(result);
      setLoadFailed(false);
      if (kind === "reply") {
        setMessage("");
        attempt.current = null;
      }
      onChanged();
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "dashboard/components/support/SupportConversation");
      if (mounted.current) setActionError(kind);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  }

  const retry = (
    <Button variant="ghost" size="sm" onClick={() => void load()} disabled={Boolean(pending)}>
      {copy.retry}
    </Button>
  );
  if (!detail)
    return (
      <section className="rounded-2xl bg-card p-6" aria-busy={loading}>
        {loadFailed ? (
          <>
            <p role="alert" className="mb-2 text-sm text-danger">
              {copy.threadFailed}
            </p>
            {retry}
          </>
        ) : (
          <div role="status" className="space-y-6 motion-safe:animate-pulse">
            <span className="sr-only">{copy.loading}</span>
            <div className="h-5 w-2/3 rounded bg-muted" />
            <div className="h-36 rounded-xl bg-muted/50" />
          </div>
        )}
      </section>
    );

  const { ticket, messages } = detail;
  return (
    <section className="overflow-hidden rounded-2xl bg-card" aria-labelledby={`${id}-title`}>
      <header className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">
            {copy.categories[ticket.category]}
          </span>
          <TicketStatus status={ticket.status} />
        </div>
        <h2
          id={`${id}-title`}
          className="break-words text-xl font-semibold leading-7 tracking-tight"
        >
          {ticket.subject}
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
            <p>
              {copy.created} <TicketTime value={ticket.createdAt} full />
            </p>
            <p className="break-all font-mono text-[10px]" title={copy.reference}>
              {ticket.id}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={Boolean(pending)}
            onClick={() => void mutate("status")}
          >
            <Icon
              name={
                pending === "status" ? "spinner" : ticket.status === "open" ? "check" : "refresh"
              }
              className={`size-4 ${pending === "status" ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {pending === "status"
              ? copy.updating
              : ticket.status === "open"
                ? copy.markResolved
                : copy.reopen}
          </Button>
        </div>
      </header>
      {loadFailed && (
        <div className="mx-5 mb-4 rounded-xl bg-danger/5 p-3">
          <p role="alert" className="text-sm text-danger">
            {copy.threadFailed}
          </p>
          {retry}
        </div>
      )}
      {actionError === "status" && (
        <p role="alert" className="mx-5 mb-4 text-sm text-danger">
          {copy.statusFailed}
        </p>
      )}
      <ol
        className="space-y-5 border-y border-border/40 bg-background/40 p-5 sm:p-6"
        aria-label={ticket.subject}
      >
        {[
          {
            id: ticket.id,
            author: "customer" as const,
            body: ticket.message,
            createdAt: ticket.createdAt,
          },
          ...messages,
        ].map((entry) => (
          <li
            key={entry.id}
            className={`rounded-xl p-4 ${entry.author === "support" ? "bg-card" : "bg-muted/40"}`}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-2 font-medium">
                <span
                  className={`flex size-6 items-center justify-center rounded-full ${entry.author === "support" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                >
                  <Icon
                    name={entry.author === "support" ? "help-circle" : "user"}
                    className="size-3.5"
                    aria-hidden="true"
                  />
                </span>
                {entry.author === "support" ? copy.team : copy.you}
              </span>
              <span className="text-muted-foreground">
                <TicketTime value={entry.createdAt} full />
              </span>
            </div>
            <p
              dir="auto"
              className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]"
            >
              {entry.body}
            </p>
          </li>
        ))}
      </ol>
      <form
        className="space-y-3 p-5 sm:p-6"
        aria-busy={Boolean(pending)}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void mutate("reply");
        }}
      >
        <label htmlFor={`${id}-reply`} className="text-sm font-medium">
          {copy.replyLabel}
        </label>
        <Textarea
          id={`${id}-reply`}
          variant="filled"
          placeholder={copy.replyPlaceholder}
          maxLength={12000}
          required
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={Boolean(pending)}
          className="min-h-28 resize-y"
        />
        {actionError === "reply" && (
          <p role="alert" className="text-sm text-danger">
            {copy.replyFailed}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xs text-xs leading-5 text-muted-foreground">
            {ticket.status === "resolved" ? copy.reopenHint : copy.refreshHint}
          </p>
          <Button type="submit" disabled={Boolean(pending) || !message.trim()}>
            <Icon
              name={pending === "reply" ? "spinner" : "arrow-right"}
              className={`size-4 ${pending === "reply" ? "animate-spin" : "rtl:rotate-180"}`}
              aria-hidden="true"
            />
            {pending === "reply" ? copy.sending : copy.sendReply}
          </Button>
        </div>
      </form>
    </section>
  );
}
