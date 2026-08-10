"use client";

/**
 * One subscription to a project's live HTTP request log.
 *
 * Extracted from `ServerLogs` because the monitoring map now wants the same feed to
 * animate hits, and the part worth not duplicating is the CONNECT decision: a cloud
 * project mints a short-lived token and talks to the SaaS edge directly, a self-hosted one
 * opens an SSE against this API, and a cloud project whose token is unavailable must NOT
 * fall through to `/server-logs/stream` (that 400s for cloud). Two copies of that branch
 * would drift, and the second consumer would be the one that quietly only works
 * self-hosted.
 *
 * Field normalisation lives here too, for a related reason: the edge's own frames, the
 * ring buffer behind `/logs/recent`, and the cloud relay each name things slightly
 * differently (`uri` vs `path`, `ts` vs `timestamp`, `status` vs `statusCode`,
 * `bw_in` vs `requestSize`). Every consumer needs the same shape, so it is produced once.
 */

import { useEffect, useRef } from "react";
import { getApiBaseUrl, api } from "@/lib/api";
import { endpoints } from "@/lib/api/endpoints";

export interface RequestLogEntry {
  id: string;
  timestamp: string;
  ip: string;
  /**
   * ISO-3166-1 alpha-2, when the edge could resolve one.
   *
   * Resolved at the EDGE (site_logger hands one lookup to both the ring buffer and the
   * live pipe), so it reflects the address nginx believes the client to be — which behind
   * Cloudflare is the visitor rather than the PoP only because of the real-ip block in
   * `edge-real-ip.ts`. Absent on a box with no GeoIP database, and for private addresses.
   */
  country?: string;
  method: string;
  path: string;
  statusCode: number;
  userAgent: string;
  /** Milliseconds. */
  responseTime: number;
  requestSize?: number;
  responseSize?: number;
  /**
   * The hostname this request hit. The edge keys its ring by host and doesn't repeat it
   * inside each row, so neither `/logs/recent` nor the live stream (both now read that one
   * ring) carries it. `/logs/recent` gets it injected API-side; the live stream gets it
   * from the per-connection target below. Lets the combined "all domains" view label which
   * domain a row belongs to; single-domain views ignore it.
   */
  host?: string;
}

function parseNumber(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      // The edge emits float SECONDS; a millisecond value would be ~1e12. Guessing by
      // magnitude beats trusting the field name, which differs per producer.
      return new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000).toISOString();
    }
    const parsed = new Date(value as string);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/** Any producer's request-log object → the one shape consumers read. */
export function normalizeRequestLog(d: unknown): RequestLogEntry | null {
  if (!d || typeof d !== "object") return null;
  const r = d as Record<string, unknown>;

  const rtRaw = r.responseTime ?? r.req_time ?? r.rt;
  return {
    id:
      (typeof r.id === "string" && r.id) ||
      `req-${String(r.ts ?? r.timestamp ?? Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: toIsoTimestamp(r.timestamp ?? r.ts ?? r.date),
    ip: (typeof r.ip === "string" && r.ip) || "-",
    country: typeof r.country === "string" && r.country ? r.country : undefined,
    method: (typeof r.method === "string" && r.method) || "GET",
    path: (typeof r.path === "string" && r.path) || (typeof r.uri === "string" && r.uri) || "/",
    statusCode:
      r.statusCode !== undefined
        ? parseInt(String(r.statusCode), 10) || 0
        : parseInt(String(r.status ?? 0), 10) || 0,
    userAgent: (typeof r.userAgent === "string" && r.userAgent) || (typeof r.ua === "string" && r.ua) || "",
    // Seconds on the wire, milliseconds in the UI.
    responseTime: rtRaw !== undefined ? Math.round(parseNumber(rtRaw) * 1000) : 0,
    requestSize: parseNumber(r.requestSize ?? r.req_size ?? r.bw_in),
    responseSize: parseNumber(r.responseSize ?? r.res_size ?? r.bw_out),
    host: (typeof r.host === "string" && r.host) || undefined,
  };
}

/** Why a stream isn't delivering, in terms a caller can show or ignore. */
export type RequestLogStreamStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "open" }
  /** The edge reported something, or the connection dropped. */
  | { state: "error"; message: string }
  /** A cloud project with no live token available. Not an error — there is simply no
   *  live tail right now, and history still loads. */
  | { state: "unavailable" };

interface Options {
  projectId: string;
  /** Restrict to one hostname (route switch / the monitoring map). Wins over `domains`.
   *  Empty/undefined streams the project's primary (or fans out across `domains`). */
  domain?: string | null;
  /** Fan out across every one of these hostnames at once — the combined "all domains"
   *  view — so a project spread over several routes never looks dead because the primary
   *  happened to be idle. Ignored when `domain` is set. Caller orders it primary-first;
   *  we cap the number of concurrent connections. */
  domains?: string[];
  /** Nothing opens while this is false. The map's live-hits switch defaults to off, and a
   *  network stream must not be opened by merely rendering a tab. */
  enabled: boolean;
  onEntry: (entry: RequestLogEntry) => void;
  onStatus?: (status: RequestLogStreamStatus) => void;
}

const appendQueryParam = (url: string, key: string, value: string) =>
  `${url}${url.includes("?") ? "&" : "?"}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;

/** Ceiling on simultaneous EventSources for the combined view. One browser holds a
 *  handful of HTTP/1.1 connections per origin; a project with dozens of routes must not
 *  starve the rest of the page. Primary-first ordering means the cap drops the least-used
 *  tail, not the domain the user cares about. */
const MAX_STREAMS = 8;

export function useRequestLogStream({ projectId, domain, domains, enabled, onEntry, onStatus }: Options) {
  // Callbacks in refs, not deps: a caller that passes an inline arrow (all of them) would
  // otherwise tear down and reopen the EventSource on every render — which for the map
  // means reconnecting several times a second while ripples animate.
  const onEntryRef = useRef(onEntry);
  const onStatusRef = useRef(onStatus);
  onEntryRef.current = onEntry;
  onStatusRef.current = onStatus;

  // Which hostnames to tail. A `null` entry means "let the server pick the primary",
  // preserving the old no-argument behaviour for the monitoring map.
  const targets: (string | null)[] = domain
    ? [domain]
    : domains && domains.length
      ? Array.from(new Set(domains.filter((d): d is string => typeof d === "string" && d.length > 0))).slice(
          0,
          MAX_STREAMS,
        )
      : [null];
  // Content, not identity: don't tear down every render just because the caller rebuilt
  // the array. Keyed by the joined target list.
  const targetsKey = targets.map((t) => t ?? "").join(",");

  useEffect(() => {
    if (!enabled || !projectId) {
      onStatusRef.current?.({ state: "idle" });
      return;
    }

    let cancelled = false;
    const sources: EventSource[] = [];
    // Aggregate N connections into one status: OPEN if any is live, UNAVAILABLE only when
    // they are all cloud-without-a-token, ERROR only when they all fail. One idle domain
    // must never blank a tail another domain is filling.
    const states = new Map<number, RequestLogStreamStatus["state"]>();
    let lastError = "closed";
    const status = (s: RequestLogStreamStatus) => {
      if (!cancelled) onStatusRef.current?.(s);
    };
    const report = () => {
      const vals = [...states.values()];
      if (!vals.length) return;
      if (vals.some((v) => v === "open")) return status({ state: "open" });
      if (vals.length === targets.length && vals.every((v) => v === "unavailable"))
        return status({ state: "unavailable" });
      if (vals.length === targets.length && vals.every((v) => v === "error" || v === "unavailable"))
        return status({ state: "error", message: lastError });
      status({ state: "connecting" });
    };

    const connectOne = (index: number, target: string | null) => {
      let es: EventSource | null = null;
      const set = (st: RequestLogStreamStatus["state"], msg?: string) => {
        states.set(index, st);
        if (st === "error" && msg) lastError = msg;
        report();
      };

      const handleRequest = (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data);
          if (d?.error) {
            set("error", String(d.error));
            return;
          }
          const entry = normalizeRequestLog(d);
          if (entry) {
            // The frame's own host wins; fall back to the connection's domain so a
            // combined view can still label the row.
            if (!entry.host && typeof target === "string") entry.host = target;
            set("open");
            onEntryRef.current(entry);
          }
        } catch {
          /* malformed frame — drop it rather than kill the stream */
        }
      };

      const handleError = (e: Event) => {
        const me = e as MessageEvent;
        if (me.data) {
          try {
            set("error", String(JSON.parse(me.data).error ?? me.data));
          } catch {
            set("error", String(me.data));
          }
          return;
        }
        // A data-less error is only terminal once the browser has given up (CLOSED);
        // during an auto-reconnect (CONNECTING) it's transient and must NOT flap the
        // aggregate to error while another domain's tail is live.
        if (es?.readyState === EventSource.CLOSED) set("error", "closed");
      };

      (async () => {
        try {
          const tokenRes = await api.get<{ kind: string; url?: string; token?: string }>(
            typeof target === "string"
              ? appendQueryParam(endpoints.projects.serverLogsStreamToken(projectId), "domain", target)
              : endpoints.projects.serverLogsStreamToken(projectId),
          );
          if (cancelled) return;

          if (tokenRes.kind === "cloud" && tokenRes.url && tokenRes.token) {
            es = new EventSource(appendQueryParam(tokenRes.url, "token", tokenRes.token));
            // A cloud edge may send unnamed messages or named `request` events.
            es.onmessage = handleRequest;
            es.addEventListener("request", handleRequest);
          } else if (tokenRes.kind === "self-hosted") {
            let url = `${getApiBaseUrl()}${endpoints.projects.serverLogsStream(projectId)}`;
            if (typeof target === "string") url = appendQueryParam(url, "domain", target);
            es = new EventSource(url, { withCredentials: true });
            es.addEventListener("request", handleRequest);
          } else {
            // Cloud project, no token right now. Deliberately does NOT fall through to
            // /server-logs/stream, which 400s for cloud.
            set("unavailable");
            return;
          }

          es.addEventListener("error", handleError);
          es.onopen = () => set("open");
          if (cancelled) {
            es.close();
            return;
          }
          sources.push(es);
        } catch {
          set("error", "connect-failed");
        }
      })();
    };

    status({ state: "connecting" });
    targets.forEach((t, i) => connectOne(i, t));

    return () => {
      cancelled = true;
      for (const es of sources) es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, targetsKey, enabled]);
}
