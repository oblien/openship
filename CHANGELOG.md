# Changelog

All notable changes to Openship. Versions follow [semver](https://semver.org);
the in-app updater surfaces critical advisories from `release-advisories.json`.

## 0.6.1

A large release. It adds a full service-to-service networking plane, around-the-clock
container health monitoring, and real analytics with visitor geography and usage
history — plus a self-contained containerized mail engine, a fleet-wide
infrastructure view with one-click updates, an audit log you can filter and attribute,
Telegram alerts, and a Node-based installer that retires the last of the Bun crash
class.

### Service-to-service networking

- **Any project can now be wired into another over the internal network** — every
  project (a plain single-app, a raw Compose stack, a monorepo, or an imported one)
  now shows a Connection card with its internal address (`http://<alias>:<port>`) and
  can be picked as a "Use in a project" source. Previously only catalog apps with a
  declared connection block, or multi-service Compose stacks, were internally
  reachable; a single-app project had no internal address at all. Same-boundary
  reachability is automatic and crossing a boundary stays explicit — an alias only
  becomes reachable once you link a consumer onto the network. Self-hosted only, and
  skipped for static sites (no listening port) and cloud-hosted apps (which link over
  Public instead).
- **Give a service a custom internal hostname** — a service can carry a custom
  east-west DNS alias that resolves alongside its default name, set from the service's
  Settings tab and available to single-app, Compose, and monorepo services alike.
  Openship normalizes it to a valid hostname and rejects one that collides with
  another service on the same project network, and the internal-address card shows the
  alias its containers actually answer to. Self-hosted only.
- **A clearer service Settings editor** — the service Settings tab groups fields into
  labelled sections and swaps free-text boxes for structured editors: ports and
  volumes are entered as chips (with per-item limits enforced as you type) and
  depends-on is a picker of the project's other services. The image and
  build-from-source fields are shown together — fill either, and a build context wins
  over a stale image — instead of an image/build mode toggle.

### Container health & incidents

- **Openship watches your containers around the clock, not just at deploy** — until
  now a container was health-checked exactly once, during the ~15s window right after
  a deploy, and then never looked at again unless a human was staring at the project
  page. A new health watch polls every server's Docker daemon once a minute (and
  reacts within about 10 seconds when Docker itself reports a container dying or
  restarting), so an app that falls over or drops into a crash loop at 3am raises an
  alert through your existing notification channels instead of waiting for a user to
  complain. Self-hosted only.
- **Broken containers page you once, not every minute** — a container stuck in a
  restart loop is broken on every poll, so a naive watcher would fire 60 alerts an
  hour about one fault. Instead each fault becomes a single incident: one message when
  it opens, one more only if it gets strictly worse (unhealthy → crash looping → down),
  and one all-clear that tells you how long it was down. A fault must be observed twice
  before it notifies, and an in-flight deploy, an operator's own `docker stop`, or a
  disabled project never trips a false alarm.
- **An unreachable server is one alert, not one per app on it** — when a box's Docker
  daemon stops answering, Openship opens a single server-level incident that names how
  many projects it can no longer monitor, and freezes those projects' health rather
  than falsely marking them recovered. The record is durable, so a box that has been
  down for days does not re-page every time the control plane restarts.
- **A Health tab on every project, with 30 days of incident history** — each project
  gets a Health tab listing its currently open incidents plus a rolling 30-day history
  of resolved ones with downtime durations. It also states whether monitoring is
  actually switched on (an operator toggle in the Jobs module) and surfaces the
  server's own outage when a box is unreachable, so an empty tab is never misread as
  "all good." Self-hosted only.

### Analytics & resource usage

- **See where your visitors come from** — the Monitoring tab draws a per-country
  choropleth of visitors alongside a ranked list, and animates real-time request
  ripples fed by the same stream the Logs tab tails, so you can watch where requests
  are landing right now. It works the same way self-hosted and on Cloud, and it can
  tell "no visitors yet" apart from "geo lookups aren't set up on this box," which
  used to render identically as an empty map. On a multi-domain project the whole
  view scopes to a chosen domain.
- **Visitor counts are real numbers now, not request counts** — the dashboard's
  visitor figure was a request count relabelled "unique IPs," so five page views from
  one browser counted as five people. It's now a genuine count of distinct visitors,
  deduplicated at the edge with a per-day salted hash that never stores an address or
  a per-visitor row — the number is honest while still collecting no behavioural data
  on your end users.
- **Top Paths and response codes that have real data behind them** — the Top Paths
  table was hardcoded empty and error rate couldn't be answered from anything saved.
  Both are real now: the daily rollup records normalized request paths (query strings
  stripped, ids collapsed, so tokens never become keys) and the full status-code mix,
  and a new card expands each 2xx/3xx/4xx/5xx class to the exact codes beneath it. On
  self-hosted, per-path aggregation is opt-in per project (a toggle, default off,
  including on existing projects) because it adds measurable work to every request the
  edge handles; on Cloud paths are aggregated automatically. Every other analytics
  dimension is unchanged.
- **Usage history is kept, so you can see what led up to a crash** — CPU, memory and
  network usage used to exist only as a live stream that vanished when you closed the
  tab, so "was memory climbing before it got OOM-killed at 3am" had no answer. Usage
  is now sampled on a schedule into 5-minute buckets and charted over time, per
  service. A Compose project reports its whole stack with a per-service breakdown and
  an All/service scope picker instead of just the one container the primary service
  owned; a static site (nothing to measure) now says so plainly instead of showing
  four zeroed metrics. Self-hosted Docker deployments; bare non-Docker deployments
  report zero network, since per-process accounting isn't available there.
- **Busy domains keep their analytics** — a domain pushing more than about 2 GB in a
  single minute (roughly 286 Mbps — routine for video or large downloads) used to
  overflow a 32-bit byte counter and kill the analytics scrape for that entire domain,
  so the busiest sites were precisely the ones with no analytics. The bandwidth
  counters are now 64-bit and collection keeps up. Self-hosted edge.
- **Analytics no longer quietly vanish when nobody is looking** — traffic analytics
  live in the edge's memory under a TTL and were only flushed to the database when
  someone opened a project's Analytics tab, so a project nobody viewed for a day lost
  its per-minute data. A background scrape job now persists every server's analytics
  on a schedule whether or not anyone is watching, collecting a whole server in one
  pass instead of a separate memory scan per domain.
- **Chart tooltips are readable in every theme** — tooltips were effectively
  transparent in the dark themes (plot lines showed straight through the text) and on
  light cards the hover marker rendered as a stray white block below the tooltip. Both
  are fixed with a shared tooltip style reused across the monitoring and billing
  charts.

### Edge & reverse proxy

- **Tune the reverse proxy per project** — a project's Routing settings now expose a
  full set of proxy tunables instead of a handful: raise or entirely remove the upload
  size limit, set connect/read/send/keepalive timeouts, control response buffering and
  gzip level, turn on HTTP/2, tighten request-header limits, and verify TLS to the
  upstream — each value validated before it reaches the generated nginx config and
  labelled with its own directive name. On self-hosted it also reads back what the
  edge is actually serving next to what you saved, flags any drift in colour, and
  offers a one-click adopt, so a hand-edited vhost or a value the sanitizer dropped
  can't quietly disagree with your settings. Self-hosted only.
- **Per-country analytics and country rules work on the containerized edge** — the
  containerized edge shipped without the MaxMind geo library or its country database,
  so every lookup returned nothing: no per-country analytics were recorded, and
  country-based route rules failed closed (a single-country ban silently blocked all
  traffic). The library and a GeoLite2 database — parsed and validated before shipping
  — are now baked into the edge image, so geo works from a box's first install with no
  runtime download.
- **Correct visitor identity behind Cloudflare or a load balancer** — behind a proxy
  the edge treated the proxy as the client, which broke four things at once: visitor
  country resolved to the PoP, distinct-visitor counts collapsed, per-IP rate limits
  put the whole planet in one bucket, and IP bans banned a PoP instead of a visitor.
  The edge now recovers the real client address from `CF-Connecting-IP`, trusting only
  Cloudflare's published ranges as the connecting peer.
- **Per-route rules reach the edge even when it isn't on the API's loopback** —
  pushing a project's route rules to a local edge now goes through the same resolved
  edge-management path as the rest of Openship instead of assuming the edge lives on
  the API host's own loopback. On setups where it doesn't — such as the containerized
  edge — rate-limit, ban, and country rules now actually take effect.
- **The "Edge ready" pill matches the server's real state** — edge readiness is now
  read from whether Openship's edge container is actually running, the same fact the
  Infrastructure tab and System Health use. Before, a leftover bare-host OpenResty
  install could make the pill claim "ready" while the server tab reported the edge as
  down.

### Custom & free domains

- **Free `.opsh.io` domains only route to a server whose control you've proven** —
  Openship Cloud's shared edge now forwards a free subdomain to your server only after
  that server answers a challenge proving it owns the target, a proof that lasts 90
  days and that Cloud re-checks about a week before it lapses. Openship prepares the
  box to answer the moment you set up its edge, so a free domain added later works
  without a redeploy, and a background sweep re-asserts, reads back over the server's
  own public address, and re-verifies anything expired — so a box left undeployed for
  months no longer silently loses its free URLs. A slug can't be pointed at someone
  else's box, and a server that can't yet answer is told why. Requires Openship Cloud.
- **Free and custom domains now work on static sites** — adding a free `.opsh.io`
  domain to a static project used to register nothing on the edge, so the URL fell
  through to the wildcard with no origin behind it; editing a static project's domain
  wrote no vhost until the next redeploy. Both now emit a real route the instant you
  save, serving the project's built files — the same behavior proxied apps already had.
- **A certificate that issued but hit a snag afterward is no longer lost** — if an
  ACME order completed but a later step failed (the vhost rewrite, the reload, or the
  read-back), the domain stayed stuck in "provisioning" with no expiry recorded, which
  made it invisible to the renewal sweep — a valid certificate then sat on the edge
  and expired ~90 days later. Openship now re-reads the edge after a failed issuance
  and records a certificate that's actually present, so renewal stays scheduled.
- **Invalid custom domains are rejected at the door** — setting a custom domain to
  something that isn't a public hostname (`localhost`, a bare IP, a single label, or a
  value with a path/port/scheme) used to return success, mint a dead pending-domain
  row, and even write a `server_name localhost;` vhost onto the shared edge. The write
  paths now validate custom hostnames and refuse bad ones, while still letting a
  project that already holds a bad value edit and remove it.
- **Editing a free domain no longer shows a false "Action Required"** — a single edit
  could sync the same free subdomain to Cloud twice, and the two racing challenges
  reset each other's token, so the route worked but the project reported "Action
  Required" anyway. Callers that run their own managed-edge sync now suppress the
  duplicate, so each edit issues one challenge and the status reflects reality.
- **Redirects and upload limits take effect on save** — raising a route's upload limit
  or adjusting its timeouts now applies as soon as you save instead of waiting for the
  next redeploy, and a domain redirect is applied live to static-site domains too, not
  only to proxied apps.

### Email

- **Mail runs as a self-contained engine instead of taking over your server** —
  setting up mail no longer installs iRedMail's daemons directly onto the host or
  reboots the box. Postfix, Dovecot, spam and virus filtering, and DKIM now run inside
  a single `openship-mail` container with its vmail database in a Postgres sidecar,
  host-networked so mail still sees real client IPs and the edge stays out of the mail
  data path. Setup is down to eight steps whose only prerequisites are Docker and the
  openship edge, and every piece of mail state (queue, maildirs, DKIM keys, config)
  lives on host bind mounts, so upgrading is a pull-and-recreate that keeps your data.
  Self-hosted only.
- **Mail uses the same edge and TLS as everything else** — mail setup no longer stands
  up its own host OpenResty and certbot on the side. The certificate for
  `mail.<domain>` is issued through the shared openship edge, the same path every other
  domain's TLS takes, and it is now recorded for renewal like any other domain — a
  mail certificate on a containerized edge (no host certbot timer) used to simply
  expire ~90 days after install, silently; a failed renewal now raises a notification.
- **Mail servers set up before containerization keep working** — the move to
  containers is topology-aware, so a server whose mail was installed the old way
  (system daemons, database on the host) still reports accurate component health and
  stays fully manageable: SQL queries, outbound SES/SMTP relay config, and daemon
  restarts all target the right engine. When the engine genuinely is stopped or was
  never installed, admin actions now return a clear message telling you to restart it
  or re-run setup instead of a bare 500 leaking a Docker "No such container" error.

### Remote infrastructure

- **See every managed edge and mail container in one place** — a new Infrastructure
  view lists each server's edge and mail container with the image version it's running
  against the version this release pins (for example edge 0.4.0 → 0.5.0), and flags
  which are behind, stopped, or missing. An attention rollup surfaces the ones that
  genuinely need hands — an edge that's down, or absent on a box that hosts projects —
  separately from the ones that merely have an update available. Self-hosted only.
- **Update, repair, or install a container without touching a shell** — Update swaps a
  behind container onto the pinned image (rollback-guarded), Fix restarts a stopped one
  in place, and a server with no edge gets a one-click Install that runs the first-
  install path with 80/443 takeover consent. Each apply streams its pull/recreate/
  verify progress and survives a dropped connection, and a fleet-wide Update all /
  Restart stopped does the same across every server at once. Self-hosted only.
- **Auto-update your remote infrastructure on upgrade** — a new instance-wide toggle
  lets the control plane update every remote edge and mail container automatically when
  you upgrade Openship (its `APP_VERSION` moves forward), so your fleet's infra tracks
  the version you're running with no manual sweep. It's server-side, so it works on
  desktop too, distinct from the desktop app's own auto-update, and off by default.
  Self-hosted only.
- **Drift detection stays current on its own** — with auto-scan on (the default),
  opening the Infrastructure tab or the home page quietly runs one detect-only scan
  when the cached state is stale, throttled to about every 30 minutes per browser, so
  the attention dot reflects reality without pressing Scan. It only refreshes what's
  shown — it never applies an update, which stays the separate auto-update toggle.
  Self-hosted only.
- **Legacy boxes are no longer flagged as broken** — a server converted to the
  containerized edge kept listing its leftover host OpenResty as a component with an
  Update button for a config nothing loads; those superseded host modules are now
  dropped from the view. And a legacy host-native mail engine (systemd Postfix/Dovecot)
  that was quietly delivering mail used to show up as "Stopped, container missing" —
  it's now labelled as not containerized rather than inventing a version. Self-hosted
  only.

### Docker migration

- **Migrated sites keep the upload limit and timeouts they ran under** — when you move
  or take over a Docker stack, the reverse-proxy tunables the source vhost declared
  (upload size limit, upstream read timeouts) are now carried onto the migrated project
  before the new edge vhost is rendered. Previously the site silently reverted to
  nginx's 1 MB / 60 s defaults at cutover, so the first large upload after a move failed
  with a 413 and nothing tied it back to the migration. Adoption is additive: a limit
  you set by hand always outranks a value inferred from the old box. Self-hosted only.
- **Adopting a stack no longer republishes internal ports** — a compose service that
  published a container port on a random host port (a single-part `ports:` entry, e.g.
  a database's 5432 the source never truly exposed) is now left unexposed during
  adoption instead of re-published on the target, so a migration doesn't needlessly
  expose internal services or collide with whatever already holds a host port. The port
  is still shown in the wizard so you can route to it, and service-to-service traffic
  keeps resolving by name over the shared network. Self-hosted only.
- **The wizard tells you which env vars weren't carried over** — when adopting a
  foreign stack, environment variables that exactly match the image's baked-in defaults
  are dropped rather than imported as explicit config (the image still supplies them at
  runtime). The wizard now lists exactly which keys were skipped and why — common with
  Coolify/Nixpacks images that bake config as ENV layers — so you know what to re-enter
  if you later change the image.
- **No more phantom hostnames in the import wizard** — the wizard used to invent a
  hostname from the project name whenever a step had no route chosen, labelling port
  fields, previewing monorepo sub-app hosts, and even wiring the "Visit Site" button to
  a host that would never exist. It now shows only hosts your config actually names, and
  hides "Visit Site" entirely when the deployment has no public domain.

### Audit log

- **See exactly what your AI assistant changed** — every audit entry now records where
  the action came in from (the dashboard, an MCP client, the CLI, the API, a webhook,
  or the system itself), and you can filter the log down to a single source. Isolating
  MCP-driven activity finally answers "what did the AI assistant do," which was
  impossible before because an MCP write and a CLI write produced identical rows.
  Entries written before this release show as an honest "unknown" rather than being
  mislabelled.
- **Turn auditing off and control how long it's kept** — each organization can switch
  audit recording on or off and pick a retention window (7, 30, 90, 180 or 365 days).
  Turning recording off stops new entries but never touches the ones already written,
  and the act of disabling is itself logged first, so the trail always explains why it
  went quiet. The switch is per-organization, so on a shared cloud instance one tenant
  can't disable everyone's audit log.
- **A real filter bar over the log** — you can narrow by category, actor, date range
  and free-text search, with a live count on every category tab. Search resolves
  project, server and domain names, so typing a name like "api-gateway" turns up
  entries that only ever stored an opaque id, and rows now display the human name of
  the affected resource, resolved server-side in one batched lookup per page.
- **Paging the log no longer skips or repeats rows** — entries that share a timestamp
  are now ordered by a stable tiebreaker, so scrolling through pages no longer
  reshuffles them; two entries created in the same instant could previously appear
  twice or vanish between pages.

### Notifications

- **Send alerts to Telegram** — Telegram joins email, Slack, Discord, and Teams as a
  notification channel: point a BotFather bot at a chat, group, or forum topic and
  Openship delivers your deploy, health, and job alerts there. The bot token is stored
  encrypted, and the channel list shows which bot does the sending.
- **Self-hosted notification settings drop the toggles that can never fire** — on a
  self-hosted box the billing notification categories are fed by the SaaS billing
  system, so they were switches that could never send anything. They no longer appear,
  and the remaining categories are organized into tabbed groups in Settings.

### Install & packaging

- **Openship now installs and updates on Node, never a global Bun** — the `curl | sh`
  and PowerShell installers download a self-contained, sha256-verified CLI payload that
  runs under Node: they use your system Node 22+ if you have one and otherwise vendor an
  official Node 22 from nodejs.org into `~/.openship`, and they quietly migrate you off
  any previous global-Bun install without touching your own Bun. `openship update` takes
  the same path — re-download the verified payload, refresh the runtime first — so an
  upgrade that raises the Node floor heals itself instead of breaking. This retires the
  Bun-vs-ssh2 crash class that could take out remote SSH operations.
- **The mail server ships as an official image** — Openship's official multi-arch
  (amd64 + arm64) image set, built and published to GHCR and Docker Hub each release,
  now includes `openship-mail` alongside the api, dashboard and edge images, so a
  self-hosted mail engine no longer has to be built from source.
- **`openship up` now works under rootless Docker instead of failing cryptically** —
  bringing up the compose stack on a rootless daemon used to abort the install with
  Docker's opaque "error while creating mount source path … permission denied," because
  a rootless daemon can't create the edge's bind-mount directories under root-owned
  paths. The CLI now creates those directories itself and, when it can't, prints the
  exact one-time `sudo mkdir`/`chown` commands to run (#372).

### Deployments & Compose

- **A working deploy is never recorded as failed** — build output that carried a raw
  NUL byte or a broken Unicode character (as a failed `docker exec` does when it spills
  its multiplexed stream, frame headers and all) made the log write fail, and Openship
  misread that rejected write as the deploy itself failing: a live, running deploy was
  marked failed and its containers torn down, while the deploy view stayed stuck on
  "Deploying." Stored build logs are now sanitized and size-capped, the outcome write
  sheds any log or error blob Postgres refuses rather than losing the status, and the
  terminal event that closes the live stream always fires.
- **Your Access URL and custom-domain ports survive a redeploy** — a project's deploy
  target is now stored durably on the project itself (a new `server_id` column) instead
  of living only in the latest deployment's volatile metadata. Before, a fresh or
  partial snapshot could lose that binding, quietly regress the project to a local
  deploy, strip the ports off its custom domains (a 502), and reset the Access URL to
  `localhost:3000`; existing server-hosted projects are backfilled so this can't bite
  them on the next redeploy. A verified custom domain is also preserved rather than
  deleted or blanked even when a deploy's endpoint set omits it. Self-hosted only.
- **A free-domain install now has a deploy target** — a box set up with a free
  `.opsh.io` domain could finish onboarding with no servers listed and nothing to
  deploy to, because registering the local "This Server" row hung off a bootstrap step
  that path never runs. The box now materializes its own deploy-target row when servers
  are first listed, when it connects to Openship Cloud, and on admin reset. Attaching a
  free `.opsh.io` domain to a project later no longer needs a redeploy first, since
  every deploy now primes the box to answer the ownership check. Self-hosted only.
- **Service domains honor your upload limit and proxy settings** — a compose service's
  own domain ignored the project's reverse-proxy tuning, so the main app would accept a
  50 MB upload while the same project's service domain rejected it at nginx's 1 MB
  default with a 413. Those settings now apply to every domain a project writes —
  per-service, static, single-domain composites, path fan-out, and single-app native
  deploys. Self-hosted only.
- **Catalog-app service URLs resolve per port and are never blank** — apps that route
  one container port to a domain and leave another port-only (Convex, for one) used to
  get an empty or self-referential origin injected (`CONVEX_SITE_ORIGIN=""`, or a
  `127.0.0.1` that inside a container points at the container itself). Each port now
  resolves independently, a port-only service falls back to the box's real reachable
  `http://host:port`, and a `{{publicUrl:…}}` token that still can't resolve is left
  unset — so the image's own default applies — with a loud warning in the deploy log
  instead of a silent blank.
- **The routing warning tells you when the edge is the problem** — when a deploy
  succeeds but its domains aren't being served, the post-deploy warning now checks why:
  if the edge container itself is down it tells you to bring the edge back up, instead
  of sending you off to your DNS provider to debug routes that are actually fine.
  Self-hosted only.

Upgrade note: this release bumps the pinned edge and mail image versions. On
self-hosted, open the new Infrastructure view to update each server's edge and mail
container onto the pinned image — or turn on instance-wide auto-update to have the
control plane do it on every upgrade.

## 0.4.9

Rollback is rebuilt so it actually restores a release, plus a round of fixes
across the MCP integration and custom domains.

### Rollback

- **Roll back any release, on every project** — the Rollback action used to be
  greyed out on projects using the default settings, because nothing marked their
  releases as restorable. It's now available on every successful release, and it
  is a single action: Openship reuses the release's retained image when it's still
  on the server (seconds, no rebuild) and rebuilds that release's commit when it
  isn't. It can no longer dead-end — the "Redeploy this commit" fallback button is
  gone because the one action already covers it, and the confirmation tells you
  which of the two you're about to get.
- **A restored release comes back complete** — a rollback now runs the same deploy
  pipeline a normal deploy does, replaying that release's own frozen configuration
  and environment variables. Previously it hand-assembled a bare container, which
  meant a "successful" rollback could come back with no environment variables, no
  published port (a 502 behind your domain) and its volumes detached. Restores now
  get the health check, the crash-loop watch, routing, logs and a build log of
  their own, exactly like any other deploy.
- **Compose stacks roll back per service** — only services whose image is missing
  are rebuilt; a service the deploy never touched keeps running on the image it
  already has, so rolling back your app code doesn't bounce your database.
- **Static sites roll back their files** — a static release's artifact is its built
  files on disk, not an image, so restoring one copies that version's files back
  into place (hard-linked, so it costs almost no extra disk) and re-points the edge
  at them. No image, no rebuild. A static rollback previously tried — and failed —
  to restart a directory as if it were a process.
- **Restoring never breaks the release you're on** — a restore reuses its source
  release's image, so two releases can share one. Retention now knows that and will
  not delete an image another retained release still needs.
- **Rollback history sizes itself to the disk** — how many releases stay restorable
  is now measured from free space on the deploy host and your project's real image
  size (a quarter of what's free, between 2 and 20 releases), instead of a fixed 5.
  You can still pin an exact number; clearing the field returns it to automatic.
- **The settings moved next to backups** — rollback retention now lives in the
  project's Backup tab, and in the deploy wizard's target panel where you pick the
  server, with the measured snapshot size and free disk shown inline. Pinning a
  release to keep it restorable indefinitely is unchanged.
- **Set retention while you're still choosing the server** — the wizard's rollback
  controls are editable on a first deploy too, and the choice is applied when the
  project is created. They used to render read-only until the project existed,
  which was the one moment you were actually looking at them. The card also names
  what a retained version *is* on your project — built files for a static site,
  images otherwise — instead of talking about images either way.
- **The wizard's Advanced panel says what's in it** — it listed only the build
  location while hiding the rollback window and clone location; it now names each
  section it contains. The summary chips next to the target (Static, Sandboxed, tier)
  lost their coloured pill backgrounds and read as plain text, with the one that
  matters — an unsandboxed "direct on host" runtime — still called out in colour.
- **Flipping the retention setting applies to existing releases** — it used to be
  frozen onto each deployment as it was created, so turning on instant rollback did
  nothing for anything already deployed.

### Fixes found while rebuilding rollback

- **Older releases could not be deployed or restored at all** — a release whose
  configuration snapshot predated the "production paths" setting crashed the deploy
  pipeline outright. This affected plain redeploys too, not just rollback.
- **A restore is no longer refused for missing build settings** — a release that
  reuses an existing image needs no install or start command, but pre-deploy checks
  demanded them. Adding a required setting would otherwise have made every older
  release un-restorable.
- **Registry-image-only projects can deploy again** — a stack adopted from a Docker
  migration has no git repository and needs none, but deploys were refused for not
  having one.
- **Compose deploys record which service ran which image** — six of the nine places
  that write per-service deployment records left the service name blank, so a later
  rollback couldn't tell services apart and rebuilt the whole stack.
- **A cleared rollback-history field no longer means "keep nothing"** — an empty
  value now falls back to the default instead of purging every restorable release.
- **Docker outside Docker Desktop is reachable** — local deploys honor `DOCKER_HOST`
  (and an explicit socket path) instead of assuming `/var/run/docker.sock`, so
  Colima, Rancher Desktop, Podman and rootless Docker work.

Upgrade note: this release drops an unused `artifact_retained_at` column from the
per-service deployment table. Nothing read or wrote it.

### MCP
- **Guided deploy flows** — the MCP server now ships a prompt catalog
  (`deploy-from-git`, `deploy-a-folder`, `install-catalog-app`, and an
  orientation overview) so an AI client follows the correct tool sequence
  instead of reverse-engineering it from a flat list. Its write tools now carry
  typed request bodies end to end (projects, deployments, domains, webhooks,
  notifications, connections, apps), and every prompt points at
  `github.com/oblien/openship/issues` when a client hits a platform bug.
- **Scoped tokens list the right tools** — a token granted a single GitHub repo
  (or the "create your own projects" scope) now correctly advertises the tools
  it can actually call. Previously the per-repo GitHub tools and the project
  create/list tools were filtered out of `tools/list`, so a scoped token saw
  nothing to work with.

### Custom domains
- **`www` is its own domain, not an attachment to yours** — "Include www" always
  created a second hostname, but the pieces around it still treated the pair as
  one thing. Renewing SSL for a domain issued the `www` certificate inside the
  same operation, unguarded: a `www` that wasn't pointed at the server yet failed
  *after* the apex had already succeeded, and the apex was reported as broken.
  Adding a domain with the switch on also showed you only the apex's DNS record,
  so `www` never resolved, its certificate could never be issued, and every
  deploy retried a hostname that had been set up to fail. Both hostnames now get
  their own DNS record, their own Verify button, their own certificate — and their
  own failure.
- **Redirect one domain to another** — any domain can now answer a 301 (or 302) to
  another domain of the same project, set on the domain's card. `www` uses it by
  default (`www.example.com` → `example.com`), and the direction is yours to flip
  or turn off. Old-domain-to-new-domain moves work the same way. The path and query
  string are preserved, the redirecting host still gets its own certificate, and a
  target outside the project — or a redirect that would loop — is refused.
- **Verify keeps the log when it fails** — the verify modal streamed certbot's
  output and then, on any failure, replaced the whole console with one line:
  "the connection closed before the operation reported a result — check the
  domain's status." The actual reason was discarded. The log now stays on screen in
  every outcome, with Copy log and Try again next to it. And if the connection
  really does drop, Openship reads the domain's state back and tells you what
  happened instead of asking you to go and look.
- **A finished run stops reporting itself as failed** — a keep-alive ping could
  race the final event of any live-log stream (verify, edge setup, deploys) and win,
  so the browser never received the result of an operation the server had already
  completed. Stream writes are serialized now, and a result that has arrived can no
  longer be overwritten by the connection closing behind it.
- **Two domains on one server no longer fight over certificates** — certificate
  issuance is serialized per server, not just per hostname. `www` made two pending
  domains the normal case, and a manual Verify could collide with the background
  retry working on the sibling: both ran certbot, both wanted the same challenge
  port, and one died with an error that read like a DNS problem.
- **The A record shows your server's IP** — on a self-hosted install the
  pre-deploy DNS panel now fills the A record's value with the server's public
  address (detected once when the server is registered) instead of leaving it
  blank.
- **Correct self-hosted DNS guidance** — the panel no longer tells you to add a
  TXT record on a self-hosted box; there isn't one — HTTPS is issued
  automatically on the first deploy. The DNS modal is also lighter and on-theme,
  and the "Include www" switch now sits below the domain field so it no longer
  shifts the input as you type.

## 0.4.7

The CLI self-hosting story is finalized, remote-Docker migrations are made
reliable, and a batch of fixes lands across the control plane for a more stable
release.

### CLI
- **A finished install opens the control panel, not the setup wizard** — bare
  `openship` (and the from-source `openship-dev`) now recognizes a Docker Compose
  install (the default on Linux). Re-running after setup manages the running
  stack instead of walking you through name / email / domain from scratch again.
- **Control-panel Start / Stop / Restart drive the actual stack** — on a compose
  install these now run `docker compose up -d` / `restart` / `down` and read the
  stack's real state, instead of targeting a systemd unit that was never
  installed (which reported "stopped" for a healthy stack).

### Migrations & remote Docker
- **The SSH → Docker bridge no longer hangs or false-fails a healthy server** —
  migrating from another platform (Coolify/Dokploy/Dokku) or adopting a running
  Docker host could stall the reachability check — or drop the request outright —
  under the Bun-hosted API, even against a perfectly healthy daemon. The bridge
  now starts reading the request socket immediately and verifies each forwarded
  channel actually carries data, falling back to `docker system dial-stdio` on a
  fresh connection when a channel opens dead. Contributed by @jbermudez00 (#271).

### Mail
- **Mail-server setup works from the desktop app** — the iRedMail engine is now
  shipped inside the packaged desktop app (and the CLI bundle) and located by an
  explicit path, fixing the `Transfer iRedMail Engine … tar: could not chdir`
  failure on install.

### Fixes
- **Self-hosted GitHub connect is token-first** — a remote (VPS) instance pastes
  an access token inline in the Library, with no `gh auth login` hints; the gh
  CLI path is now desktop-only, where it belongs.
- **The deploy wizard lands on configuration directly** — the deploy-target
  picker no longer flashes on entry. A sensible target is applied silently and
  stays one click away in the summary bar at the top.
- **The control plane stops listing a phantom service** — the self-managed
  "Openship" project no longer shows a bogus public `openship` service (and its
  stray `openship-openship.opsh.io` route) that matched no container and read
  "Stopped" forever.

## 0.4.0

A security fix for the edge, migrations that behave like a native repo project,
and a batch of routing/reliability fixes.

### Security
- **Unrouted HTTPS hosts are rejected, not cross-served** — the edge now owns a
  `443` default server that refuses any hostname it doesn't route (one you
  removed, never added, or merely pointed at the box's IP). Before this, such a
  request fell through to the first-loaded vhost and was served **another app's
  certificate and backend**. Applies automatically on the next deploy, on both the
  bare and containerized edge. Critical — see the in-app advisory.

### Migrations
- **A migrated project is now a native repo project** — a migrated compose stack
  redeploys like any repo project: it reclones and **rebuilds `build:` services**
  and pulls `image:` ones, instead of failing on a frozen build tag (`404 no such
  image`). The running image is reused only **once**, at cutover.
- **The whole compose is the deployment plan** — the migrate screen lists every
  repo compose service, not just running containers, so a service with no
  container (e.g. `redis`, or an app that wasn't up) is built/pulled and routed
  like the rest, with its env and route editable on the card.
- **Reused databases stay reachable** — a reused container is joined to the new
  project's network under its service-name alias, so a freshly-built app resolves
  `postgres:5432` by name, exactly like a native deploy.
- **A migrated service reports the container it really runs as** — service state
  is read live from the host and matched by identity (label → `openship-<slug>-<svc>`
  name → tracked id → compose labels), so a container Openship adopted **in place**
  (its docker labels still name the previous project) no longer shows "Stopped"
  while it serves traffic. Each run's log now ends with the container, state and
  match for every service.

### Fixes
- **Service state is never guessed from the database** — Start/Stop/Restart, logs,
  terminal, backup/restore and volume sizes resolve the container against the host
  first, so a redeploy that replaced it no longer leaves them failing with
  `no such container` — or, on Start, launching a **duplicate** container beside
  the running one. A crash-looping container now reads **Restarting** instead of a
  green "Running", and an unreachable host reads **Unknown** instead of echoing the
  last deploy status.
- **Removing a route never wrongly demands Openship Cloud** — the free-domain gate
  classifies by hostname, so removing a custom-domain route (or any route) is no
  longer blocked by an unrelated free subdomain still in the set.
- **Deleting a service can't hang** — runtime teardown is time-bounded, so a slow
  or unreachable server no longer strands the delete before the record is removed.

<!-- editors: highlights only, trim/adjust before tagging — not rendered on the website -->

## 0.2.4

Native Apple Silicon builds, drop-in compatibility with other platforms' deploy
config, and a batch of self-hosting and reliability fixes.

### Downloads
- **Native Apple Silicon (arm64) desktop app** — macOS now ships separate
  **arm64** and Intel **x64** dmgs (both built and SHA-256-checksummed in CI), so
  Apple Silicon Macs run natively instead of under Rosetta. Windows (x64) and
  Linux (AppImage) are unchanged.

### Deploy · stack detection
- **Deploys repos already configured for another platform, as-is** — the stack
  detector now reads **`railway.toml`/`railway.json`** and **`vercel.json`**
  (build / install / start / output commands, framework, and routing) and folds
  them over its own detection. A repo that already tells Railway or Vercel how to
  build it deploys the same way here, no reconfiguration. Every config source
  runs through one shared parser registry (no per-source special-casing).
- **`openship.json`** — an optional repo-root config to declare build, routing,
  env, and domains up front; it's authoritative over auto-detection and rides the
  same engine, for the repo root and each monorepo sub-app.

### Self-hosting
- **Deploys to your own server by default** — a self-hosted instance targets the
  server it runs on, never Openship Cloud, unless you explicitly choose cloud.
- **Health checks work when the control plane is containerized** — the
  post-deploy probe reaches your app through the host gateway, so a containerized
  self-host no longer fail-reverts an otherwise-healthy deploy.
- **OpenResty installs on newer distros** — the edge install no longer pins the
  APT repo to a codename that doesn't exist yet (e.g. Ubuntu 26.04), and self-heals
  a box already broken by the old pin.

### CLI
- **`openship stop` actually stops** — the service and its children are reaped by
  process group and any ports it held are swept, so a restart can't strand the
  old process on a new port.

### Reliability & fixes
- Malformed JSON request bodies now return **400**, not 500.
- **Cloud static-output path is confined** — the Pages output path resolves
  through one shared, sandboxed resolver so a build can't escape its output dir.
- Mail DNS scan **detects duplicate DMARC records**.
- OAuth discovery metadata is served correctly **behind a public URL**.
- SSH exec streams **close cleanly on timeout** instead of leaking.
- Bumped the Laravel deploy **test fixture** off a vulnerable `laravel/framework`
  (CRLF email advisory) — a fixture only, never a shipped dependency.

<!-- editors: highlights only, trim/adjust before tagging — not rendered on the website -->

## 0.2.2

Apps and Jobs grow up, a self-hosted server can now talk to GitHub on its own,
Backups get a real home, and a batch of delete/login/database reliability fixes.

### Apps
- **Day-2 app settings** — installed apps now expose a curated settings surface
  (schema-driven) so you can change an app's real config after install without
  digging through raw env. Edits go through a safe env-merge and tell you whether
  a full redeploy (vs a quick restart-apply) is needed.
- **Clean per-app install wizard** — clicking a catalog app opens a focused,
  business-only setup that creates the project on confirm; the technical deploy
  wizard is now the "Advanced" path (no more orphaned draft projects from a
  half-finished install).
- **Openship Mail is a first-class app** — it appears in the catalog alongside
  Convex and n8n and hands off to the mail wizard. The rest of the catalog shows
  as **Coming soon** (dimmed, not installable) for this release.

### Jobs
- **Automated backups show up in Jobs** (read-only) — backup schedules run on the
  same job runner as everything else (zero duplication), so their next/last run
  sits right next to your system and custom jobs.

### Servers · GitHub
- **Connect GitHub on a server** — each self-hosted server now authenticates to
  GitHub on its own, from a dedicated **GitHub** tab: sign in with a device code
  (like `gh`), paste a token, generate an SSH key to add to your account, or use
  auto-registered read-only per-repo **deploy keys**. Credentials are stored
  encrypted and the exact same connect panel is reused inside the deploy flow, so
  a missing credential is one click to fix mid-deploy. Private-repo clones now
  work without your desktop online.

### Backups
- **Redesigned Backups** — per-destination storage stats, a sticky status rail,
  and clickable rows that open a per-destination detail page showing exactly which
  projects and services back up there.

### Cloud
- **Per-user project cap** — Openship Cloud enforces a hard cap on projects per
  user (env `CLOUD_MAX_PROJECTS_PER_USER`, default 2), at both create and
  folder-upload/ensure. Self-hosted is unmetered.

### Reliability & polish
- **Deletes never get stuck** — project deletion shows a real **Deleting** state,
  and when the source teardown can't complete you get a clean **"Delete from
  storage"** option that drops the record immediately (leftover resources are
  reclaimed later by GC). The atomic, all-or-nothing delete stays the default.
- **Desktop sign-in fix** — the login redirect now lands on the same loopback host
  the session cookie was minted on (`localhost` ⇄ `127.0.0.1`), so the dashboard
  no longer opens cookieless and bounces you back to `/login`.
- **Embedded database start-up** — no more false "locked by a different machine"
  on your own box when the machine-id probe is momentarily flaky; the cross-machine
  guard now only fires on a genuinely different, stable machine id.
- **Calmer, consistent theming** — status colors (success / warning / danger /
  info) are unified semantic tokens across the whole dashboard, and the dim
  theme's greens and reds are tuned for comfortable contrast.
- Servers empty state refreshed — clearer illustration, a **See docs** action, and
  a distinct icon per "what gets configured" tile.

## 0.2.0

A large feature + hardening release across the deploy flow, the app catalog,
routing, servers, jobs, and the build toolchain.

### Deploy
- Redesigned **"Where do you want to deploy?"** step: unified page-style header
  with the **Continue** action aligned to the config column, and a **collapsed,
  searchable server picker** (with an inline "Add your own server").
- **Package-manager toolchain fix** — pnpm/yarn are now enabled via `corepack`
  across every build path (cloud, generated Dockerfile, bare host, monorepo
  workspace-prepare, cloud local-build). Fixes `pnpm: not found` on deploy.

### Apps
- **Searchable, category-tabbed one-click app catalog**, expanded to 15
  production-ready self-hosted apps: Convex, n8n, Ghost, Directus, NocoDB,
  Metabase, Grafana, Gitea, code-server, Uptime Kuma, Vaultwarden, FreshRSS,
  Stirling PDF, IT-Tools, Excalidraw.
- Home "Apps" card refreshed; catalog cards show real brand logos.

### Routing & domains (single source of truth)
- Custom domains on **service-based projects** now flow through the same
  verify → DNS-records → SSL pipe as single-app domains: a verifiable pending
  row is minted on add/create/edit, one canonical hostname normalizer is shared
  across storage/routing/domain-service, lookups are cross-tenant-safe, and
  certbot is gated on verification (no wasted Let's Encrypt attempts).

### Servers
- Redesigned servers page (tabs, live reachability, country flags).
- Per-server **Git** auth tab (token / SSH key / deploy keys) with a
  comfortable full-width card; connect-on-server credentials honored in preflight.

### Jobs
- Jobs page gains **search** + an at-a-glance **status filter sidebar**
  (running / failed / scheduled / disabled), shown once custom jobs exist.

### Team & workspace
- **Invite member** is only offered where it works (team orgs on a multi-user
  instance); single-user/personal instances are guided to migrate or create a
  team org instead of hitting a dead end.

### Add service
- The **Openship Cloud** image tab shows a "Connect to Openship Cloud" CTA when
  the instance isn't linked, and the source switcher has clearer contrast.

### Other
- Docker migration flow, per-project/service backups, unified connectivity
  checks, Arabic (RTL) localization, marketing roadmap page, and desktop window
  polish (macOS traffic-light inset).

<!-- editors: highlights only, trim/adjust before tagging — not rendered on the website -->
