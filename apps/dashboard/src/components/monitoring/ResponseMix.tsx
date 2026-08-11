"use client";

/**
 * Response-code mix for the window.
 *
 * Status was captured into the edge's raw-request ring buffer (RAM, 1h) but never
 * aggregated, so "what's my error rate" was unanswerable from any persisted data.
 * It is now a daily counter, and this is where it surfaces — a card that exists
 * mainly to make a rising 5xx share visible without reading logs.
 *
 * ── Classes AND exact codes ─────────────────────────────────────────────────
 *
 * This showed only 2xx/3xx/4xx/5xx, which threw away data the whole stack already
 * carries: the edge counts `g:{domain}:{day}:s:{status}` with nginx's actual status, the
 * mgmt API returns `{"200":n,"404":n}`, the scraper upserts that jsonb verbatim and
 * geo.service sums it per code. Only this component collapsed it — so "4xx is 2.1%" was
 * visible while "…and nearly all of it is 429" was not, even though the number was sitting
 * in Postgres.
 *
 * The class stays the top-level unit because it is the right first read (a rising 5xx share
 * is the thing you want to notice without looking). Each class now expands to the exact
 * codes underneath it, ordered by count, so the follow-up question — WHICH failure — is
 * answerable in the same card instead of by reading logs.
 */

import React, { useMemo } from "react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { formatCount } from "./format";

interface Props {
  statuses: Record<string, number> | undefined;
}

/** Semantic tokens, never hardcoded hues — 5xx must read as danger in every theme. */
const CLASSES = [
  { key: "2xx", test: (n: number) => n >= 200 && n < 300, bar: "bg-success", text: "text-success" },
  { key: "3xx", test: (n: number) => n >= 300 && n < 400, bar: "bg-info", text: "text-info" },
  { key: "4xx", test: (n: number) => n >= 400 && n < 500, bar: "bg-warning", text: "text-warning" },
  { key: "5xx", test: (n: number) => n >= 500 && n < 600, bar: "bg-danger", text: "text-danger" },
] as const;

export const ResponseMix: React.FC<Props> = ({ statuses }) => {
  const { t } = useI18n();
  const m = t.projects.monitoring;

  const { buckets, codes, total, unclassified } = useMemo(() => {
    const counts = new Map<string, number>();
    /** class key → its exact codes, biggest first. */
    const perCode = new Map<string, Array<{ code: string; count: number }>>();
    let sum = 0;
    let other = 0;
    for (const [code, count] of Object.entries(statuses ?? {})) {
      const n = Number(code);
      if (!Number.isFinite(n) || typeof count !== "number" || count <= 0) continue;
      const cls = CLASSES.find((c) => c.test(n));
      // An unrecognised code (nginx's own 0 for a connection dropped before a response)
      // is counted in the total but not attributed to a class — better than silently
      // dropping it and reporting shares that don't add up. Surfaced explicitly below,
      // because a total that exceeds the sum of the classes otherwise looks like a bug.
      sum += count;
      if (!cls) {
        other += count;
        continue;
      }
      counts.set(cls.key, (counts.get(cls.key) ?? 0) + count);
      const list = perCode.get(cls.key) ?? [];
      list.push({ code, count });
      perCode.set(cls.key, list);
    }
    for (const list of perCode.values()) {
      // Descending: the code you need to see is the one there is most of.
      list.sort((a, b) => b.count - a.count || Number(a.code) - Number(b.code));
    }
    return { buckets: counts, codes: perCode, total: sum, unclassified: other };
  }, [statuses]);

  if (total === 0) return null;

  return (
    <div className="self-start rounded-2xl bg-card p-5">
      <h3 className="mb-4 text-sm font-medium text-foreground">{m.statusesTitle}</h3>

      {/* One stacked bar: the 5xx sliver is the thing worth noticing at a glance. */}
      <div className="mb-4 flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {CLASSES.map((c) => {
          const n = buckets.get(c.key) ?? 0;
          if (n === 0) return null;
          return (
            <span
              key={c.key}
              className={c.bar}
              style={{ width: `${(n / total) * 100}%` }}
              title={`${c.key}: ${formatCount(n)}`}
            />
          );
        })}
      </div>

      {/* ROWS, not columns.
          This was `sm:grid-cols-4`, which is fine at full width and broken here: the
          card lives in a two-column grid, so each track got ~100px while "86.3K 86.3%"
          needs more — the values overflowed their track and printed on top of the next
          class label. Four rows can't collide, and each value gets a fixed column so the
          numbers align instead of ragging. */}
      <ul className="space-y-1.5">
        {CLASSES.map((c) => {
          const n = buckets.get(c.key) ?? 0;
          const pct = total > 0 ? (n / total) * 100 : 0;
          return (
            <li key={c.key}>
              <div className="flex items-center gap-3 text-sm">
                <span
                  aria-hidden
                  className={`size-2 shrink-0 rounded-full ${n > 0 ? c.bar : "bg-muted"}`}
                />
                <span className={`font-medium ${n > 0 ? c.text : "text-muted-foreground/50"}`}>
                  {c.key}
                </span>
                {/* Eats the slack so the two number columns stay hard right. */}
                <span className="min-w-0 flex-1" />
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatCount(n)}</span>
                <span className="w-14 shrink-0 text-right tabular-nums text-xs text-muted-foreground/70">
                  {interpolate(m.share, { pct: pct.toFixed(1) })}
                </span>
              </div>

              {/* The exact codes behind the class.
                  Suppressed when there is only ONE, because "4xx / 404" on two lines
                  says the same thing twice. Indented under the class rather than made a
                  separate list, so the hierarchy is visible without a heading. */}
              {(codes.get(c.key)?.length ?? 0) > 1 && (
                <ul className="mt-1 space-y-0.5 pl-5">
                  {codes.get(c.key)!.map((e) => (
                    <li
                      key={e.code}
                      className="flex items-center gap-3 text-xs text-muted-foreground"
                    >
                      <span className="tabular-nums">{e.code}</span>
                      <span className="min-w-0 flex-1" />
                      <span className="shrink-0 tabular-nums">{formatCount(e.count)}</span>
                      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground/60">
                        {interpolate(m.share, { pct: ((e.count / total) * 100).toFixed(1) })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {/* Codes outside 200-599. In practice this is nginx's `0`, logged when the client
          disconnects before any response line is written. (499 — nginx's own "client closed
          request" — is inside 4xx and classifies normally.) Counting these only in the
          total made the four class shares look like they were failing to add up. */}
      {unclassified > 0 && (
        <p className="mt-3 border-t border-border/50 pt-2 text-xs text-muted-foreground/70">
          {interpolate(m.statusesUnclassified, { count: formatCount(unclassified) })}
        </p>
      )}
    </div>
  );
};
