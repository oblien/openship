# Monitoring

Openship's per-project Monitoring tab answers three questions — what is my app using
right now, where is my traffic coming from, and what is it returning — and it is designed
so that answering them costs your visitors nothing.

This page explains the architecture and states the measured cost, because "we collect
analytics" is usually a euphemism for "every request now does extra work".

---

## The short version

| | |
|---|---|
| Work added to a visitor's request | **~1.4 µs** of in-memory counter updates (+~3.1 µs with Top Paths on), plus a country lookup that is 0.01 µs cached / 2.5 µs on a cache miss — all **after** the response is already sent |
| I/O on the request path | **none** — no socket, no HTTP call, no file write, no database |
| Rows written to Postgres per request | **zero** |
| Rows written to Postgres per day | ≤1440 per domain, +1 per domain, +288 per service |
| Is the control plane in the request path? | **No.** A visitor's request never reaches the API or the database |

The design principle: **the edge counts, the control plane collects.** Requests increment
counters in shared memory; a scheduled job moves those already-aggregated numbers into
Postgres every 30 minutes. Nothing per-request ever crosses a process boundary.

---

## The request path

Traffic is measured by OpenResty — the same process already terminating TLS and proxying
to your container. It runs one Lua handler,
[`site_logger.lua`](../packages/adapters/src/infra/lua/site_logger.lua), in nginx's
**`log_by_lua`** phase.

That phase matters: it runs *after* the response has been written to the client. Measuring
a request cannot delay it, because by the time the measuring happens the visitor already
has their bytes.

What the handler does, per request:

- **around a dozen `incr` / `safe_add` calls** against `ngx.shared.DICT` zones — nginx's
  own shared memory, in-process, atomic across workers. A few are conditional: response
  time only when non-zero, the "page request" counter only for non-static URLs, the
  distinct-visitor counter only on that visitor's first request of the day.
- **one shared-dict `get`** to check whether per-path collection is switched on for this
  host (see [Top Paths is opt-in](#top-paths-is-opt-in)).
- **one `set`** into a fixed 1000-slot ring buffer holding recent raw requests, for the
  Logs tab and the live map.

There is no socket, no HTTP client, no file handle and no database driver anywhere in it.
Two things follow: it cannot block on a network round trip, and it cannot fail in a way
that affects the response.

### It aggregates; it does not insert

This is the part that keeps the cost flat as traffic grows. A request does **not** create
a record. It adds to counters that already exist:

```
s:{domain}:{minute}:r        request count for this minute
s:{domain}:{minute}:i / :o   bytes in / out
g:{domain}:{day}:{CC}        hits from this country today
g:{domain}:{day}:s:{code}    responses with this exact status today
```

The thousandth request in a given minute touches exactly the same keys as the first. Ten
requests per second and ten thousand requests per second write the same number of keys —
only the numbers in them differ.

### Everything unbounded is bounded

Counter keys are fixed per (domain, minute) and (domain, day), but three things could grow
with hostile input, so each is capped:

- **Paths** — off by default (below); when on, a URL-fuzzing scanner would otherwise mint a
  permanent key per probed URL, so query strings are stripped, numeric and UUID segments
  collapse to `:id`, and past 2000 distinct paths per domain per day the tail folds into a
  single `other` bucket.
- **Raw request log** — a fixed 1000-slot ring, 1-hour TTL. Slot 1001 overwrites slot 1;
  the zone never grows.
- **Distinct visitors** — a per-day salted hash per visitor, in its own 64 MB zone (≈1M
  distinct/day). Past that the zone evicts and the count *understates*, which the UI is
  told about: `GET /status` reports each zone's free space, and the dashboard marks the
  figure approximate rather than presenting an eviction artifact as a measurement.

Each zone is sized separately and deliberately, so a high-cardinality flood in one cannot
evict the counters in another.

### Measured cost

Benchmarked by running the handler's exact shared-dict writes in a loop inside the real
`openship-edge` image (aarch64, 2 vCPU container, 300,000 iterations, 5 samples):

| | per request |
|---|---|
| Counters only | **2.86 – 3.18 µs** |
| Counters + raw-log ring record | **4.11 – 4.40 µs** |

The ~1.3 µs difference is almost entirely the `cjson.encode` of the raw-log record.

Broken down by dimension, which is what explains why one of them is opt-in:

| dimension | per request |
|---|---|
| **paths** (whole block) | **1.72 µs** |
| — of which string work (`normalize_path`, static-asset check) | 1.38 µs |
| minute buckets (5 × `incr`) | 0.61 µs |
| country (2 × `incr`) | 0.24 µs |
| status (1 × `incr`) | 0.14 µs |
| the opt-in flag itself (1 × `get`) | 0.07 µs |

And the country lookup, which is not a counter and deserves its own line — it is the single
most expensive thing on the path when it misses cache:

| | per request |
|---|---|
| country: LRU hit (a repeat visitor) | **0.010 µs** |
| country: mmdb lookup (LRU miss) | **2.3 – 2.8 µs** |

**There is no disk in this path**, and the cache is not there to avoid one.

The database is memory-mapped, so after first touch it is resident in the page cache, shared
across workers, with no read syscall per lookup — "the database in memory", which is what
mmap is for. It is opened once per worker.

The few µs a lookup costs is **CPU, not I/O**. Measured with the whole 8.7 MB file already
read into the page cache, then repeating the *same* addresses three times:

```
raw mmdb walk, pass 1 (cold pages)   5.550 µs
raw mmdb walk, pass 2 (warm)         5.450 µs
raw mmdb walk, pass 3 (warm)         5.450 µs
```

Flat. Nothing was waiting on storage. That time is the MMDB format itself: a binary search
tree walked one node per address bit (up to 128 hops for IPv6), then a data-section decode,
plus one FFI crossing. Copying the same bytes onto the Lua heap would run the identical walk
over the identical memory — and cost far more, because 1.4 M nodes as Lua tables is hundreds
of MB of GC-managed objects *per worker* instead of 8.7 MB shared.

So the LRU is not a disk cache, it is a **memoization of that tree walk** — which is why it
is worth ~250×, and why removing it would mean paying the full walk on every request rather
than eliminating a miss. Realistic cost therefore tracks IP diversity: a site with regulars
pays ~0.01 µs, one being scanned by a fresh address every request pays single-digit µs.

For scale: on a request that takes 5 ms to serve, 4 µs is about **0.08%**. On a box doing
1000 req/s it is roughly 0.4% of one CPU core.

Three honest caveats. First, this measures the analytics work itself, driven in a tight
loop; a real request also pays nginx's own log-phase overhead, which exists whether or not
you collect anything, and it will not enjoy the same warm cache. Second, the figure is from
one machine — treat it as the order of magnitude, not a guarantee for your hardware. Third,
it is not *zero*: it is small, measured, and it happens after the response has been sent.

---

## Top Paths is opt-in

Every dimension above is effectively free because the edge is already handling the request
— except one. Per-path counting is **1.72 µs of the 3.0 µs** counter path (57%), and 1.38 µs
of that is string work: stripping the query, collapsing `/orders/48219` to `/orders/:id`,
and checking whether the URL is a static asset. It is also the highest-cardinality dimension
(up to 2000 keys per domain per day, against ~200 countries and a few dozen statuses) and
the largest column in the daily rollup.

So it is a per-project switch, **off by default**, including for projects that existed
before the switch did — nobody opted into the cost, so nobody keeps paying it unasked.

Turn it on from the Top Paths card on the Monitoring tab; the same card's ⋯ menu turns it
back off. With it off the counter path drops to about **1.4 µs** per request.

Mechanically: the flag is `project.collect_paths` in Postgres, pushed to each of the
project's hostnames as `cfg:{host}:paths` in the edge's `rules` shared dict. The log handler
reads it with a single `get` (0.07 µs) and skips the whole block when it is absent. The
`rules` zone rather than `analytics` on purpose — `analytics` is a 256 MB churn of counters
under LRU pressure, and an evicted flag there would silently change what is collected.

### Keeping the edge and the database in step

The flag is cached in RAM, so it has exactly two ways to drift, and both are known:

| event | flag survives? |
|---|---|
| `openresty -s reload` (a routing change) | **yes** — the shared-memory zone survives a reload |
| full restart (reboot, `docker restart`, image upgrade) | **no** — the zone is empty |

Absent means off, so a restarted box stops collecting paths while the database still says
it should. Three things keep that from being a silent, permanent mismatch:

1. **Every route apply re-pushes** — so any deploy or domain change corrects it immediately.
2. **The 30-minute analytics sweep re-asserts every project's setting on every edge**, one
   round trip per server. That bounds drift after a restart to one sweep rather than to the
   next deploy, which for a stable project could be weeks.
3. **Off is a single state.** The edge deletes the key rather than storing `0`, so "never
   set", "explicitly disabled" and "lost to a restart" are the same value. Two
   representations of off is how a reader ends up treating one of them as on.

The honest summary: this is **eventually consistent with a ≤30-minute window**, not
transactional. That window is the same one all of this analytics already lives with — the
counters themselves are in RAM and a full restart loses whatever hadn't been scraped, so the
flag is no weaker a link than the data it governs.

---

## Getting it into Postgres

The edge holds counters in RAM with a TTL (24h for minute buckets, 48h for daily
rollups). A scheduled job moves them out before they expire.

**`analytics:scrape`**, every 30 minutes (`13,43 * * * *`):

1. One connection per server — not per project, not per domain.
2. One `POST /analytics/collect` covering **every** domain on that box, served from a
   single shared-dict scan. (This used to be 2N+1 unbounded scans for N domains; on a
   50-domain box that was 101 full scans of a 256 MB zone per sweep.)
3. Minute buckets are flushed — read and deleted atomically — and bulk-upserted.
4. The daily rollup is *not* flushed: the edge keeps running totals for the day, so each
   scrape re-reads the whole day and the upsert overwrites. Re-scraping is idempotent.

Servers are processed **serially**. Each one means an SSH connect or a `docker exec`, and
hammering fifty boxes at once is how a metrics sweep becomes an outage. Nothing is waiting
on this tick.

Viewing the tab *also* triggers a scrape, for freshness on top of the schedule. That path
is staleness-gated (cross-process, so a second dashboard tab doesn't double it) and
in-flight-deduped, so repeated reads inside the window don't re-hit the server.

### How many rows

Steady state, after retention settles:

| Table | Rows/day | Retention | Steady state |
|---|---|---|---|
| `server_analytics` (minute buckets) | ≤1440 per domain | 90 days | ≤129,600 per domain |
| `server_analytics_geo` (daily rollup) | 1 per domain | 400 days | 400 per domain |
| — its `paths` column | only when Top Paths is on | | |
| `resource_usage` (5-min samples) | 288 per service | 30 days | 8,640 per service |

`≤1440` because a bucket row exists only for a minute that actually had traffic — the
collector emits a bucket only when that minute's counter exists. A site with hourly cron
traffic writes ~24 rows a day, not 1440. 1440 is the ceiling for a domain receiving at
least one request every minute of the day.

A five-service project on one busy domain therefore settles at roughly **173,000 rows** —
a few tens of MB, and the writes arrive as two small batches per hour rather than as a
stream.

Pruning runs nightly: `analytics:retention-prune` (04:23) and `resources:retention-prune`
(04:29).

---

## The one part that isn't free

**Resource sampling is different in kind from traffic**, and it's worth understanding why.

Traffic is counted for *free*: the edge is already handling the request, so incrementing a
counter is incidental. Resource usage requires an **active probe** — `docker stats` on each
container — and the daemon must collect two CPU samples to produce a percentage, so each
call occupies it for roughly **a second** — orders of magnitude more than the cheap
`docker inspect` the health watch uses.

That single fact drives the design:

- **The cadence is the resolution.** `resources:sample` runs every 5 minutes
  (`1-59/5 * * * *`), giving 288 points per service per day. Sampling faster buys detail at
  a real and growing price.
- **Bounded concurrency** — 8 in flight per server, so a 20-service stack doesn't fire 20
  concurrent one-second calls.
- **A per-server budget** — 120 samples per sweep. Overflow is *counted and reported* in
  the job summary, never silently dropped.
- **Stopped containers are skipped**, which is free and avoids paying a second for a
  container that has nothing to report.

The live per-second view in the tab is a separate SSE stream that exists only while you
have the tab open, and it reads the service list from the database once per stream rather
than once per tick.

---

## What is and isn't collected

Visitor counts are a **count, never an identity**. The address is hashed with a salt that
is generated on your box, rotates daily, and is never written anywhere but that shared-dict
zone — so the marker keys are not reversible to an IP and are worthless the next day. Only
the resulting counter reaches Postgres. No per-visitor row exists at any layer.

Raw request logs (IP, path, user agent) live in the edge's 1000-slot ring for one hour and
are never persisted by the control plane.

### Behind Cloudflare or another proxy

If the edge sits behind a proxy, the connecting peer is the *proxy*, and without handling
that, every visitor's country resolves to the PoP, distinct-visitor counts collapse toward
the number of PoPs, and per-IP rate limits bucket everyone behind one PoP together.

Openship recovers the real client address using nginx's `realip` module with Cloudflare's
published ranges, honouring `CF-Connecting-IP`. The trust is anchored to *who opened the
socket*: the header is believed only when the peer is a trusted address, so sending it
yourself at the origin does nothing. See
[`edge-real-ip.ts`](../packages/adapters/src/infra/edge-real-ip.ts) for why
`CF-Connecting-IP` and not `X-Forwarded-For`.

For a non-Cloudflare proxy, set `OPENSHIP_EDGE_TRUSTED_PROXIES` (comma-separated CIDRs)
and optionally `OPENSHIP_EDGE_REAL_IP_HEADER`.

---

## On Openship Cloud

On the SaaS, traffic analytics live at Oblien's edge and are read through on demand —
never scraped into a local database. Both the `analytics:scrape` and
`analytics:retention-prune` jobs are unavailable there, because there is nothing local to
collect or prune. Resource usage *is* sampled on cloud (the cloud runtime implements the
same usage interface), so both sampling and its retention prune run in that mode.

The dashboard reads one shape either way: a single resolver reports whether a project's
traffic source is self-hosted or cloud, and the tab does not know the difference.
