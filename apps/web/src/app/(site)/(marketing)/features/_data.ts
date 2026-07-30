import {
  Rocket,
  GitBranch,
  Boxes,
  Layers,
  Undo2,
  ScrollText,
  Scale,
  CalendarClock,
  Globe,
  Cable,
  ShieldAlert,
  Database,
  Mail,
  LayoutDashboard,
  Bot,
  type LucideIcon,
} from "lucide-react";

/**
 * Features catalog — one source of truth for the `/features` grid and each
 * `/features/[slug]` detail page. `screenshot` is a `/public` path when a real
 * capture exists, or `null` to render the framed placeholder (see FeatureShot).
 * Keep copy honest: describe what ships today.
 */

export type FeatureCategory = "Deploy" | "Run" | "Connect" | "Data" | "Manage";

export const CATEGORY_ORDER: FeatureCategory[] = ["Deploy", "Run", "Connect", "Data", "Manage"];

export const CATEGORY_BLURB: Record<FeatureCategory, string> = {
  Deploy: "From your code to production.",
  Run: "Keep it healthy at any scale.",
  Connect: "Your edge, domains, and network.",
  Data: "Stateful services, managed.",
  Manage: "Drive it your way.",
};

export interface Feature {
  slug: string;
  title: string;
  category: FeatureCategory;
  /** One line for the grid card + detail sub-header. */
  tagline: string;
  icon: LucideIcon;
  /** `/public` path, or null → framed placeholder. */
  screenshot: string | null;
  /** Lead paragraph on the detail hero. */
  summary: string;
  /** Body paragraphs on the detail page. */
  body: string[];
  /** 3–4 concrete sub-capabilities. */
  highlights: { title: string; desc: string }[];
}

export const FEATURES: Feature[] = [
  // ── Deploy ────────────────────────────────────────────────────────────────
  {
    slug: "deploy-anywhere",
    title: "Deploy anywhere",
    category: "Deploy",
    tagline: "Openship Cloud, your own VPS, or a homelab — one workflow.",
    icon: Rocket,
    screenshot: null,
    summary:
      "The same deploy, wherever it runs. Ship to Openship Cloud, connect your own VPS, or point at a machine in your closet — the workflow never changes, and your servers stay yours.",
    body: [
      "Add a server with an SSH connection and it becomes a first-class deploy target: builds, routing, logs, rollbacks, and metrics all work identically to the managed cloud. No lock-in, no separate tooling per environment.",
      "Start on one box and grow into many. As you add machines, Openship treats them as a fleet you can ship to as one — so moving from a single homelab node to a production cluster is a change of scale, not a rewrite.",
    ],
    highlights: [
      { title: "Bring your own servers", desc: "Any Linux box over SSH becomes a target — cloud VPS, dedicated, or homelab." },
      { title: "Identical everywhere", desc: "Same build, routing, and rollback pipeline on managed cloud and self-hosted." },
      { title: "No lock-in", desc: "Your data and workloads live on your infrastructure. Leave whenever you want." },
    ],
  },
  {
    slug: "push-to-deploy",
    title: "Push to deploy",
    category: "Deploy",
    tagline: "Connect a repo — every push builds, tests, and ships.",
    icon: GitBranch,
    screenshot: null,
    summary:
      "Link a GitHub repository and every push turns into a deploy. On the managed cloud the GitHub App wires it up natively; self-hosted registers the webhook for you — no YAML, no CI to maintain.",
    body: [
      "Each commit to your deploy branch builds the project, runs your commands, and rolls out with zero downtime. Pull requests get their own preview environment with a shareable URL, torn down automatically when the branch merges.",
      "Prefer to trigger deploys from elsewhere? Incoming webhooks give any CI system, cron, or script a signed URL that redeploys on demand — the same pipeline, triggered your way.",
    ],
    highlights: [
      { title: "Preview environments", desc: "A live URL per pull request, cleaned up on merge." },
      { title: "Native or webhook", desc: "GitHub App on cloud; auto-registered webhook on self-hosted." },
      { title: "Branch environments", desc: "Map branches to production, staging, or ephemeral previews." },
    ],
  },
  {
    slug: "any-stack",
    title: "Any language, any stack",
    category: "Deploy",
    tagline: "Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepos.",
    icon: Boxes,
    screenshot: null,
    summary:
      "Openship detects your framework, language, package manager, and commands — then builds and runs it. Node.js and Docker are fully native today; every other stack deploys through the universal pipeline with your own commands.",
    body: [
      "For JavaScript/TypeScript and any Dockerfile or Compose file, there's nothing to configure: link the repo and ship. For Go, Rust, Python, Ruby, PHP, Java/Kotlin, .NET, and Elixir, bring your install/build/start commands (or a Dockerfile) and deploy the same way — with first-class native detection rolling out stack by stack.",
      "Monorepos are first-class: point each service at its subdirectory and share build caches across the workspace.",
    ],
    highlights: [
      { title: "Auto-detected", desc: "Framework, package manager, and commands inferred from your repo." },
      { title: "Docker-native", desc: "Any Dockerfile or Compose stack runs as-is, no translation." },
      { title: "Monorepo-aware", desc: "Multiple services from one repo, each with its own root." },
    ],
  },
  {
    slug: "compose-multi-service",
    title: "Compose & multi-service",
    category: "Deploy",
    tagline: "Ship a whole stack — app, worker, db — as one project.",
    icon: Layers,
    screenshot: "/compose.png",
    summary:
      "Bring a docker-compose file and Openship deploys every service as a managed, privately-networked project — the app, the worker, the queue, the database — coordinated as one.",
    body: [
      "Each service gets its own build, logs, health checks, and scaling, while they talk to each other over a private network with no exposed ports. Partial-failure deploys are held for your decision rather than leaving the stack half-updated.",
      "Add, remove, or restart a single service without redeploying the whole project — the rest keep serving traffic.",
    ],
    highlights: [
      { title: "Compose-native", desc: "Your existing docker-compose file is the source of truth." },
      { title: "Per-service control", desc: "Independent logs, env, scaling, and restarts." },
      { title: "Safe rollouts", desc: "Partial failures pause for a keep-or-rollback decision." },
    ],
  },
  {
    slug: "instant-rollbacks",
    title: "Instant rollbacks",
    category: "Deploy",
    tagline: "Every deploy is an immutable snapshot. Revert in one click.",
    icon: Undo2,
    screenshot: null,
    summary:
      "Every deployment is captured as an immutable snapshot, so going back is instant and safe — pick any previous version and it's live again with zero downtime.",
    body: [
      "Choose how far back to keep artifacts per project. Snapshot rollbacks restore the exact built image and workspace; git rollbacks re-clone and rebuild at the previous commit — you pick the trade-off between speed and disk.",
      "Because rollbacks are just another deploy of a known-good version, they go through the same health-checked, zero-downtime path as any release.",
    ],
    highlights: [
      { title: "Immutable snapshots", desc: "Each release is preserved exactly as it shipped." },
      { title: "One-click revert", desc: "Restore any retained version instantly, no rebuild." },
      { title: "Tunable retention", desc: "Keep as many previous versions as you want per project." },
    ],
  },
  // ── Run ─────────────────────────────────────────────────────────────────
  {
    slug: "logs-monitoring",
    title: "Live logs & monitoring",
    category: "Run",
    tagline: "Streaming logs and real-time metrics across every service.",
    icon: ScrollText,
    screenshot: null,
    summary:
      "Tail logs live across services and replicas, and watch CPU, memory, network, and disk in real time — from the dashboard, the CLI, or your desktop app.",
    body: [
      "Logs stream as they happen, with search and filtering, and persist so you can go back after an incident. Request logs surface status codes, latency, and paths for every route.",
      "Metrics update in real time with charts per service, so you can see a deploy's impact the moment it lands.",
    ],
    highlights: [
      { title: "Live tail", desc: "Follow stdout across services and replicas, filtered and searchable." },
      { title: "Request logs", desc: "Status, latency, and path for every inbound request." },
      { title: "Real-time metrics", desc: "CPU, memory, network, and disk, charted per service." },
    ],
  },
  {
    slug: "jobs-triggers",
    title: "Jobs & triggers",
    category: "Run",
    tagline: "Cron-like jobs and webhook-triggered actions with live logs.",
    icon: CalendarClock,
    screenshot: null,
    summary:
      "Run scheduled or on-demand jobs with per-run logs and history — and fire deploys or jobs from an incoming webhook when something outside Openship happens.",
    body: [
      "Jobs run on a cron schedule, once at a set time, or manually with a Run-Now button, streaming their output live. Every run is recorded with its logs for later inspection.",
      "Incoming webhooks turn any external event into an action: each hook is a signed URL with its own token or HMAC that can redeploy a project or run a job.",
    ],
    highlights: [
      { title: "Scheduled & manual", desc: "Cron, one-shot, or run-now — with live streaming output." },
      { title: "Per-run history", desc: "Every run's logs and outcome retained and searchable." },
      { title: "Webhook triggers", desc: "Signed URLs (token/HMAC) that deploy or run a job on demand." },
    ],
  },
  {
    slug: "autoscaling-load-balancing",
    title: "Scaling & load balancing",
    category: "Run",
    tagline: "Health-checked, weighted routing with zero-downtime rollouts.",
    icon: Scale,
    screenshot: null,
    summary:
      "Distribute traffic across healthy instances with built-in health checks and weighted routing, and roll out new versions without dropping a request.",
    body: [
      "Rolling restarts and connection draining make zero-downtime deploys the default. As clustering matures, horizontal scaling per service — up on traffic, down when idle — is coming to the same one-click surface.",
      "Weighted routing lets you shift traffic gradually between versions or nodes when you want more control than an all-at-once swap.",
    ],
    highlights: [
      { title: "Zero-downtime", desc: "Rolling restarts with connection draining on every deploy." },
      { title: "Health-checked", desc: "Unhealthy instances are pulled from rotation automatically." },
      { title: "Weighted routing", desc: "Shift traffic gradually across versions or nodes." },
    ],
  },
  // ── Connect ─────────────────────────────────────────────────────────────
  {
    slug: "domains-ssl",
    title: "Domains & SSL",
    category: "Connect",
    tagline: "Unlimited custom domains, wildcard certs, auto-renewal.",
    icon: Globe,
    screenshot: null,
    summary:
      "Add as many custom domains as you like, with automatic Let's Encrypt certificates — including wildcards — that renew themselves. No add-ons, no caps, no per-domain metering.",
    body: [
      "Point a domain, verify it in seconds, and Openship provisions and renews the certificate for you. Set a primary domain, add redirects, and manage records visually.",
      "Routing failures never fail a deploy — your build ships and any domain issue is surfaced separately so a DNS hiccup can't block a release.",
    ],
    highlights: [
      { title: "Unlimited domains", desc: "Apex and subdomains, no per-domain fees." },
      { title: "Auto SSL", desc: "Let's Encrypt with wildcard support and automatic renewal." },
      { title: "Visual DNS", desc: "Records and verification, with clear propagation status." },
    ],
  },
  {
    slug: "private-networking",
    title: "Private networking",
    category: "Connect",
    tagline: "Services talk over an isolated network — no exposed ports.",
    icon: Cable,
    screenshot: null,
    summary:
      "Services in a project reach each other over a private network, so your database and internal APIs never need a public port. Wire one app into another as a ready connection.",
    body: [
      "\"Use in a project\" injects a database or service's connection details into another project as secret environment variables — internally over the shared network, or via the published host and port when you need public reach.",
      "Only what you choose to expose gets a public route; everything else stays private by default.",
    ],
    highlights: [
      { title: "No exposed ports", desc: "Internal services stay off the public internet." },
      { title: "One-click wiring", desc: "Inject a DB/service connection into another project as env vars." },
      { title: "Private by default", desc: "Expose only the routes you explicitly publish." },
    ],
  },
  {
    slug: "route-rules-waf",
    title: "Edge route rules & WAF",
    category: "Connect",
    tagline: "Per-route rate limits, geo/UA filters, and bans — applied live.",
    icon: ShieldAlert,
    screenshot: null,
    summary:
      "Compose per-route rules — rate limits, geo and user-agent filters, bans, hotlink protection — and apply them instantly at the edge, with no reloads and no config files.",
    body: [
      "Rules are stored as the source of truth and pushed live to the edge, so a change takes effect immediately without a restart. Available on self-hosted today, with the managed WAF and cloud parity in progress.",
      "Build up a policy per route and edit it from the dashboard — the edge enforces it for every request.",
    ],
    highlights: [
      { title: "Per-route policies", desc: "Rate limits, geo/UA filters, bans, and hotlink protection." },
      { title: "Live, no reloads", desc: "Rule changes take effect instantly at the edge." },
      { title: "Dashboard-managed", desc: "No config files — compose and edit rules visually." },
    ],
  },
  // ── Data ────────────────────────────────────────────────────────────────
  {
    slug: "managed-databases",
    title: "Managed databases",
    category: "Data",
    tagline: "Postgres, Redis, MongoDB, MySQL — provisioned and backed up.",
    icon: Database,
    screenshot: null,
    summary:
      "Spin up PostgreSQL, Redis, MongoDB, or MySQL in a click — auto-provisioned, privately networked, and backed up on a schedule you control.",
    body: [
      "Databases come with scheduled backups and restore, and connect into your apps over the private network with a single wiring step. Object storage (S3-compatible) rounds out the stateful services.",
      "Back up to your own destination — S3, SFTP, or elsewhere — with retention policies and webhook-triggered runs.",
    ],
    highlights: [
      { title: "One-click provisioning", desc: "Postgres, Redis, MongoDB, MySQL, and object storage." },
      { title: "Scheduled backups", desc: "Automated backups + restore to your own destinations." },
      { title: "Private wiring", desc: "Connect a database into any project over the internal network." },
    ],
  },
  {
    slug: "mail",
    title: "Mail server & delivery",
    category: "Data",
    tagline: "Self-hosted mail, or relay through Amazon SES / SMTP.",
    icon: Mail,
    screenshot: "/email-preview.png",
    summary:
      "Send from your own domain with the authentication chain auto-configured — or connect Amazon SES or any SMTP relay and manage senders, domains, and deliverability from Openship.",
    body: [
      "Provision a full mail stack with a built-in webmail client, or keep receiving self-hosted while relaying outbound through SES or SMTP for deliverability. One settings surface drives all system mail — password resets, invites, verification, and notifications.",
      "SPF, DKIM, and DMARC are wired for you, so mail from your domain lands where it should.",
    ],
    highlights: [
      { title: "Self-host or relay", desc: "Full mail stack, or SES/SMTP send-relay — your choice." },
      { title: "Auth auto-configured", desc: "SPF, DKIM, and DMARC set up for your domain." },
      { title: "Webmail included", desc: "A clean built-in client for the provisioned mail stack." },
    ],
  },
  // ── Manage ──────────────────────────────────────────────────────────────
  {
    slug: "dashboard-cli-desktop",
    title: "Dashboard, CLI & desktop",
    category: "Manage",
    tagline: "Deploy from a browser, a single binary, or a native app.",
    icon: LayoutDashboard,
    screenshot: "/screen.png",
    summary:
      "Drive everything from a fast web dashboard, a single-binary CLI, or a native Mac/Windows desktop app — deploys, logs, secrets, domains, and rollbacks, all in one place.",
    body: [
      "The dashboard covers visual deploys, metrics, team access, and billing. The CLI puts the same power in one binary for scripting and CI. The desktop app pushes from your machine and streams logs natively.",
      "Secrets are encrypted at rest and environment-scoped; every action is captured in an exportable audit log.",
    ],
    highlights: [
      { title: "Three surfaces", desc: "Web dashboard, single-binary CLI, and native desktop app." },
      { title: "Secrets vault", desc: "Encrypted, environment-scoped, rotated without redeploying." },
      { title: "Audit log", desc: "Every action recorded and exportable for compliance." },
    ],
  },
  {
    slug: "ai-mcp",
    title: "AI & MCP",
    category: "Manage",
    tagline: "Drive deploys from Claude, Cursor, or any MCP client.",
    icon: Bot,
    screenshot: null,
    summary:
      "Openship ships an MCP server, so AI agents can deploy, read logs, manage domains, and more — through standard, authenticated tools, scoped to exactly what you allow.",
    body: [
      "Connect Claude, Cursor, or any MCP client and let it operate your infrastructure with the same permissions model as a human — including narrow scopes like \"only projects it creates.\"",
      "Every agent action runs through the same authorization and audit path as the dashboard and CLI, so AI access is powerful without being a back door.",
    ],
    highlights: [
      { title: "Standard MCP", desc: "Works with any MCP client — Claude, Cursor, and more." },
      { title: "Scoped tokens", desc: "Grant an agent only the projects and actions you choose." },
      { title: "Fully audited", desc: "Agent actions run the same authz + audit path as everything else." },
    ],
  },
];

export function getFeature(slug: string): Feature | undefined {
  return FEATURES.find((f) => f.slug === slug);
}

export function relatedFeatures(feature: Feature, count = 3): Feature[] {
  const sameCat = FEATURES.filter((f) => f.category === feature.category && f.slug !== feature.slug);
  const others = FEATURES.filter((f) => f.category !== feature.category && f.slug !== feature.slug);
  return [...sameCat, ...others].slice(0, count);
}
