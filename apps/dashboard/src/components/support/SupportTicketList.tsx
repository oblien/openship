"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { CloudSupportCustomerList } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSupportApi } from "./support-api";
import { getApiErrorMessage } from "@/lib/api/client";
import { supportTicketHref, TicketStatus, TicketTime } from "./support-shared";

export function SupportTicketList({
  selectedId,
  revision,
}: {
  selectedId: string | null;
  revision: number;
}) {
  const { t } = useI18n();
  const cloudSupportApi = useSupportApi();
  const copy = t.support;
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<(CloudSupportCustomerList & { key: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const cursor = useRef<string | null>(null);
  const key = JSON.stringify([filter, query]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (append = false) => {
      const request = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        const result = await cloudSupportApi.list({
          ...(filter === "all" ? {} : { status: filter }),
          ...(query ? { search: query } : {}),
          ...(append && cursor.current ? { before: cursor.current } : {}),
        });
        if (!mounted.current || generation.current !== request) return;
        cursor.current = result.nextCursor;
        setPage((previous) => {
          const tickets =
            append && previous?.key === key
              ? [...previous.tickets, ...result.tickets]
              : result.tickets;
          return {
            ...result,
            key,
            tickets: [...new Map(tickets.map((ticket) => [ticket.id, ticket])).values()],
          };
        });
      } catch (err) {
        if (mounted.current && generation.current === request)
          setError(getApiErrorMessage(err, copy.loadFailed));
      } finally {
        if (mounted.current && generation.current === request) setLoading(false);
      }
    },
    [filter, query, key, copy.loadFailed, cloudSupportApi],
  );

  useEffect(() => {
    mounted.current = true;
    cursor.current = null;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [load, revision]);

  const current = page?.key === key ? page : null;
  const tickets = current?.tickets ?? [];
  const filtered = filter !== "all" || Boolean(query);
  return (
    <section className="overflow-hidden rounded-2xl bg-card" aria-label={copy.myTickets}>
      <div className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{copy.myTickets}</h2>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={loading}
            onClick={() => void load()}
            aria-label={copy.refresh}
          >
            <Icon
              name="refresh"
              className={`size-4 ${loading ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
          </Button>
        </div>
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute start-3.5 top-3.5 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            variant="filled"
            type="search"
            className="ps-10"
            aria-label={copy.search}
            placeholder={copy.search}
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div
          className="flex rounded-xl bg-background/70 p-1"
          role="group"
          aria-label={copy.filterLabel}
        >
          {(["all", "open", "resolved"] as const).map((value) => (
            <Button
              key={value}
              variant="ghost"
              size="sm"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`min-w-0 flex-1 rounded-lg px-2 text-xs ${filter === value ? "bg-card text-foreground" : "text-muted-foreground"}`}
            >
              {value === "all" ? copy.all : copy.status[value]}
            </Button>
          ))}
        </div>
      </div>
      {error && (
        <div className="mx-5 mb-4 rounded-xl bg-danger/5 p-3 text-sm">
          <p role="alert" className="text-danger">
            {error}
          </p>
          <Button variant="ghost" size="sm" className="mt-1" onClick={() => void load()}>
            {copy.retry}
          </Button>
        </div>
      )}
      <div className="max-h-[38rem] overflow-y-auto px-2 pb-2" aria-busy={loading}>
        {loading && !tickets.length ? (
          <div role="status" className="space-y-4 p-3">
            <span className="sr-only">{copy.loading}</span>
            {[0, 1, 2].map((value) => (
              <div
                key={value}
                className="space-y-3 rounded-xl bg-muted/40 p-4 motion-safe:animate-pulse"
              >
                <div className="h-3 w-3/4 rounded bg-muted" />
                <div className="h-3 w-1/2 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : (
          tickets.map((ticket) => (
            <Link
              key={ticket.id}
              href={supportTicketHref(ticket.id)}
              scroll={false}
              aria-current={selectedId === ticket.id ? "page" : undefined}
              className={`mb-1 block rounded-xl px-3 py-4 transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                selectedId === ticket.id
                  ? "bg-primary/8 ring-1 ring-inset ring-primary/20"
                  : "hover:bg-muted/60"
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {copy.categories[ticket.category]}
                </span>
                <span className="text-xs text-muted-foreground">
                  <TicketTime value={ticket.updatedAt} />
                </span>
              </div>
              <p className="line-clamp-2 break-words text-sm font-medium leading-6">
                {ticket.subject}
              </p>
              <div className="mt-3 flex items-center justify-between gap-2">
                <TicketStatus status={ticket.status} />
                <span className="font-mono text-[10px] text-muted-foreground/70" title={ticket.id}>
                  {ticket.id.slice(-8)}
                </span>
              </div>
            </Link>
          ))
        )}
        {!loading && !error && !tickets.length && (
          <div className="px-4 py-10 text-center">
            <Icon
              name="mail"
              className="mx-auto mb-3 size-6 text-muted-foreground/50"
              aria-hidden="true"
            />
            <p className="text-sm font-medium">{filtered ? copy.noMatches : copy.emptyTitle}</p>
            {filtered ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => {
                  setFilter("all");
                  setSearch("");
                  setQuery("");
                }}
              >
                {copy.clearFilters}
              </Button>
            ) : (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {copy.emptyDescription}
              </p>
            )}
          </div>
        )}
        {current?.nextCursor && (
          <Button
            variant="ghost"
            size="sm"
            className="my-2 w-full"
            disabled={loading}
            onClick={() => void load(true)}
          >
            {copy.loadMore}
          </Button>
        )}
      </div>
    </section>
  );
}
