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
  Eye,
  Workflow,
  ServerCog,
  Gauge,
  Waypoints,
  Webhook,
  GitPullRequest,
  Grid2X2,
  HardDrive,
  Archive,
  Cloud,
  Server,
  ArrowRightLeft,
  Download,
  Bell,
  KeyRound,
  KeySquare,
  FileText,
  Fingerprint,
  HeartPulse,
  RefreshCw,
  Building2,
  UserCog,
  ShieldCheck,
  Mailbox,
  CheckCheck,
  FolderGit2,
  Terminal,
  FileCode2,
  Code2,
  type LucideIcon,
} from "lucide-react";

/**
 * Features catalog — one source of truth for the `/features` grid and each
 * `/features/[slug]` detail page. `screenshot` is a `/public` path when a real
 * capture exists; pages without a capture use a text-first layout.
 * Keep copy honest: describe what ships today.
 */

export type FeatureCategory =
  | "Deploy"
  | "Run"
  | "Connect"
  | "Data"
  | "Manage"
  | "Secure"
  | "Collaborate";

export const CATEGORY_ORDER: FeatureCategory[] = [
  "Deploy",
  "Run",
  "Connect",
  "Data",
  "Manage",
  "Secure",
  "Collaborate",
];

export const CATEGORY_BLURB: Record<FeatureCategory, string> = {
  Deploy: "From your code to production.",
  Run: "Workflows, execution, and service health.",
  Connect: "Your edge, domains, and network.",
  Data: "Stateful services, managed.",
  Manage: "Drive it your way.",
  Secure: "Control credentials, access, and changes.",
  Collaborate: "Give every teammate the right access.",
};

export interface Feature {
  slug: string;
  title: string;
  category: FeatureCategory;
  /** One line for the grid card + detail sub-header. */
  tagline: string;
  icon: LucideIcon;
  /** An actual product capture from `/public`, when available. */
  screenshot: string | null;
  /** Lead paragraph on the detail hero. */
  summary: string;
  /** Body paragraphs on the detail page. */
  body: string[];
  /** 3–4 concrete sub-capabilities. */
  highlights: { title: string; desc: string }[];
  guide: string;
  availability?: string;
}

export const FEATURES: Feature[] = [
  {
    slug: "local-folder-deploys",
    title: "Deploy local folders",
    category: "Deploy",
    icon: Terminal,
    tagline: "Ship local source without creating a Git repository first.",
    summary:
      "Import a project from your machine through the desktop workflow, folder upload, or CLI. Review detection and stream its build output to the chosen destination.",
    body: [
      "Select a local project or upload a folder, then review the detected stack, commands, and destination. Openship sends source files while excluding rebuildable dependencies, Git metadata, and common build outputs.",
      "Redeploy subsequent local changes into the same project. Source upload and build location are separate choices: importing a local folder does not mean every build executes on your laptop.",
    ],
    highlights: [
      { title: "Local source", desc: "Deploy a folder before connecting a repository." },
      { title: "Lean uploads", desc: "Exclude dependencies and common generated build output." },
      { title: "Repeat deployments", desc: "Ship new local changes into the existing project." },
    ],
    screenshot: null,
    guide: "/docs/guides/deploy-local-folder",
  },
  {
    slug: "configuration-as-code",
    title: "Configuration as code",
    category: "Deploy",
    icon: FileCode2,
    tagline: "Keep supported project settings in openship.json.",
    summary:
      "Version deployment configuration beside your source. Declare supported build, runtime, service, and health settings in a file you can review with a code change.",
    body: [
      "Create openship.json in the project and use the published schema to review supported fields. Configure commands, runtime options, mounts, or service settings where supported by the selected deployment path.",
      "The configuration parser validates declared values before applying them. Available behavior depends on the runtime; schema support for a setting does not imply every destination can execute it. Keep sensitive credentials in the configured credential and variable settings.",
    ],
    highlights: [
      {
        title: "Versioned settings",
        desc: "Review supported deployment configuration with source changes.",
      },
      {
        title: "Schema guidance",
        desc: "Use documented fields and validation to catch invalid settings.",
      },
      {
        title: "Runtime context",
        desc: "Choose values supported by the intended deployment path.",
      },
    ],
    screenshot: null,
    guide: "/docs/reference/openship-json",
  },
  {
    slug: "api-sdk",
    title: "API & TypeScript SDK",
    category: "Manage",
    icon: Code2,
    tagline: "Automate platform operations with documented HTTP routes and typed clients.",
    summary:
      "Integrate Openship into your own tooling through the API and SDK. Read resources, deploy projects, inspect operation status, and manage authorized workflows from code.",
    body: [
      "Connect a client to the intended instance with an authorized credential and workspace context. The generated reference maps SDK methods to HTTP routes and explains required capabilities and destination availability.",
      "Use operation IDs and documented progress or log interfaces for long-running work. API and SDK calls use the platform's permission checks; a typed request is not a substitute for access to the resources involved.",
    ],
    highlights: [
      {
        title: "Typed clients",
        desc: "Use the published TypeScript SDK for supported operations.",
      },
      {
        title: "HTTP reference",
        desc: "Find request shapes, permission requirements, and examples.",
      },
      {
        title: "Operation visibility",
        desc: "Follow long-running work through status and progress interfaces.",
      },
    ],
    screenshot: null,
    guide: "/docs/api",
  },
  // ── Deploy ────────────────────────────────────────────────────────────────
  {
    slug: "deploy-anywhere",
    guide: "/docs/getting-started/first-deployment",
    title: "Deploy anywhere",
    category: "Deploy",
    tagline: "Openship Cloud, your own VPS, or a homelab — one workflow.",
    icon: Rocket,
    screenshot: null,
    summary:
      "Choose where your application lives: managed Cloud, a connected server, or your homelab. Keep source, builds, deployments, domains, and logs together.",
    body: [
      "Connect an SSH-accessible server or choose managed Cloud compute, then select it when creating a project. Inspect its capabilities and configure the build and runtime your application needs.",
      "Self-host the controller, manage remote servers through the desktop app, or use Openship Cloud. Infrastructure operations and runtimes depend on the destination; setup shows the supported choices.",
    ],
    highlights: [
      {
        title: "Your infrastructure",
        desc: "Connect a VPS, dedicated machine, or homelab over SSH.",
      },
      { title: "Managed Cloud", desc: "Choose supported compute and inspect its plan and usage." },
      {
        title: "Portable projects",
        desc: "Use the migration and transfer workflows to move workloads.",
      },
    ],
  },
  {
    slug: "push-to-deploy",
    guide: "/docs/guides/auto-deploy",
    title: "Push to deploy",
    category: "Deploy",
    tagline: "Connect a repository and deploy changes from your chosen branch.",
    icon: GitBranch,
    screenshot: null,
    summary:
      "Link a GitHub repository, choose a deployment branch, and enable automatic deployments. Follow each matching release through source revision, build output, and activation.",
    body: [
      "Matching GitHub App or webhook events enter the deployment pipeline with your source and build settings. Review install, build, and start commands before enabling automatic deployment.",
      "Add required Actions checks when a release should wait for CI. A push does not automatically test the application unless you configure those checks or commands. Previews have their own settings and lifecycle.",
    ],
    highlights: [
      {
        title: "Branch environments",
        desc: "Create a separate environment from a selected branch.",
      },
      {
        title: "Native or webhook",
        desc: "GitHub App on cloud; auto-registered webhook on self-hosted.",
      },
      { title: "Release checks", desc: "Configure the required checks before release activation." },
    ],
  },
  {
    slug: "any-stack",
    guide: "/docs/guides/openship-json",
    title: "Languages & build settings",
    category: "Deploy",
    tagline: "Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepos.",
    icon: Boxes,
    screenshot: null,
    summary:
      "Deploy JavaScript, Python, Go, Rust, PHP, Ruby, and other container-ready applications. Review supported stack detection, runtime versions, and commands before building.",
    body: [
      "Detection supplies a starting configuration for supported frameworks and package managers. Select a project subdirectory and override install, build, or start commands for your application.",
      "Use a Dockerfile for a specific system image or toolchain. Runtime version settings and repository declarations are checked for supported native stacks, including PHP; custom images remain available for other requirements.",
    ],
    highlights: [
      {
        title: "Reviewable detection",
        desc: "Inspect and override the detected framework and commands.",
      },
      { title: "Runtime versions", desc: "Choose supported language versions for your build." },
      { title: "Monorepos", desc: "Give each project its own root directory and configuration." },
    ],
  },
  {
    slug: "compose-multi-service",
    guide: "/docs/guides/compose-multi-service",
    title: "Compose & multi-service",
    category: "Deploy",
    tagline: "Ship a whole stack — app, worker, db — as one project.",
    icon: Layers,
    screenshot: "/compose.png",
    summary:
      "Import a Compose definition and operate its supported services in one project. Review images, variables, dependencies, persistent storage, and public routes before deployment.",
    body: [
      "Import a Compose definition from a repository or stack file. Review supported service settings, images, variables, dependencies, storage, and public routes in the deployment plan.",
      "Expose services that need public access and keep internal dependencies private. Each service has runtime logs and controls while the project keeps shared deployment history. Unsupported settings require review.",
    ],
    highlights: [
      {
        title: "Compose-native",
        desc: "Your existing docker-compose file is the source of truth.",
      },
      { title: "Per-service control", desc: "Inspect service logs, variables, and runtime state." },
      { title: "Safe rollouts", desc: "Partial failures pause for a keep-or-rollback decision." },
    ],
  },
  {
    slug: "instant-rollbacks",
    guide: "/docs/guides/rollback-redeploy",
    title: "Release history & rollbacks",
    category: "Deploy",
    tagline: "Restore a retained application image from deployment history.",
    icon: Undo2,
    screenshot: null,
    summary:
      "Return to an available retained release when an application change goes wrong. Openship creates a rollback deployment using its recorded image and configuration.",
    body: [
      "Inspect a previous release and review its restore plan before rolling back. Retained images avoid rebuilding old source against new dependencies. Artifact availability follows your configured retention.",
      "Replacement images are prepared before activation. Service cutover remains sequential, and rollback does not reverse database writes or restore persistent volumes; use a backup for data recovery.",
    ],
    highlights: [
      {
        title: "Retained artifacts",
        desc: "Restore an available image without a new source build.",
      },
      { title: "Restore plan", desc: "Review the target release and required changes first." },
      {
        title: "Separate data recovery",
        desc: "Use backups when data state must also be restored.",
      },
    ],
  },
  // ── Run ─────────────────────────────────────────────────────────────────
  {
    slug: "logs-monitoring",
    guide: "/docs/guides/logs-monitoring",
    title: "Logs, metrics & incidents",
    category: "Run",
    tagline: "Streaming logs and real-time metrics across every service.",
    icon: ScrollText,
    screenshot: null,
    summary:
      "Inspect build logs, service output, HTTP requests, traffic analytics, resource usage, and health notices from the project view.",
    body: [
      "Switch between build output, a service runtime stream, and request logs. Search, copy, or download visible output. Request analytics summarize paths, response times, status codes, and bandwidth.",
      "Monitoring checks deployed services and records incidents. If a server cannot be observed, Openship reports unavailable monitoring rather than declaring applications stopped. A successful check after connectivity returns updates that state.",
    ],
    highlights: [
      {
        title: "Service output",
        desc: "Select the runtime to inspect in a multi-service project.",
      },
      {
        title: "Request analytics",
        desc: "Review paths, latency, status codes, and traffic totals.",
      },
      {
        title: "Connection-aware health",
        desc: "Distinguish a workload failure from unavailable monitoring.",
      },
    ],
  },
  {
    slug: "jobs-triggers",
    guide: "/docs/guides/jobs",
    title: "Scheduled jobs & automation",
    category: "Run",
    tagline: "Cron-like jobs and webhook-triggered actions with live logs.",
    icon: CalendarClock,
    screenshot: null,
    summary:
      "Schedule application commands or invoke saved Actions workflows. Keep execution history and logs alongside your deployments.",
    body: [
      "Create a recurring cron job, set a one-time execution, or press Run now. Select an application command or saved workflow and provide its declared inputs where required.",
      "Runs use the selected authorized destination. Review their status and logs, adjust the schedule, or disable future runs. Workflow execution follows its configured controller and access policy.",
    ],
    highlights: [
      { title: "Three trigger choices", desc: "Recurring, one-time, and on-demand execution." },
      {
        title: "Commands or workflows",
        desc: "Use a project command or the shared Actions execution path.",
      },
      { title: "Run history", desc: "Inspect the outcome and logs of each execution." },
    ],
  },
  {
    slug: "autoscaling-load-balancing",
    availability:
      "Cluster operations require a self-hosted or desktop controller and are unavailable on the hosted Cloud controller.",
    guide: "/docs/guides/mcp-clusters-and-scaling",
    title: "Clusters & application replicas",
    category: "Run",
    tagline: "Prepare a cluster and change application replica counts explicitly.",
    icon: Scale,
    screenshot: null,
    summary:
      "Group registered servers, prepare K3s, and deploy supported applications with multiple replicas. Scale an active application using its existing image.",
    body: [
      "Connect selected servers over a verified private network, prepare the cluster runtime, and select it as the project destination. Setup has prerequisites, progress, and recoverable operations.",
      "Set replicas for supported applications or workers and inspect ready pods and routing. Policy-driven autoscaling, automatic gateway failover, and Compose scaling through this application path are not implemented.",
    ],
    highlights: [
      { title: "Managed setup", desc: "Prepare networking and the runtime on registered servers." },
      { title: "Image reuse", desc: "Change replicas without rebuilding application source." },
      {
        title: "Observed state",
        desc: "Inspect ready replicas rather than just saved configuration.",
      },
    ],
  },
  // ── Connect ─────────────────────────────────────────────────────────────
  {
    slug: "domains-ssl",
    guide: "/docs/guides/custom-domains",
    title: "Domains & SSL",
    category: "Connect",
    tagline: "Connect domains, verify DNS, and manage HTTPS certificates.",
    icon: Globe,
    screenshot: null,
    summary:
      "Put your application on a domain you control. Openship guides DNS verification and certificate setup and keeps status visible next to the deployment.",
    body: [
      "Add a domain to its project or service, point DNS to the displayed target, and verify it. Set the primary address and inspect routing and HTTPS status in the same view.",
      "Self-hosted destinations use their certificate workflow, including automatic renewal; managed Cloud uses its edge certificate path. Wildcard and DNS-provider requirements vary by destination and configuration.",
    ],
    highlights: [
      {
        title: "Custom addresses",
        desc: "Connect apex domains and subdomains to the intended service.",
      },
      { title: "Verification status", desc: "See DNS and HTTPS issues with recovery actions." },
      {
        title: "Certificate lifecycle",
        desc: "Use the supported provisioning and renewal workflow.",
      },
    ],
  },
  {
    slug: "private-networking",
    availability:
      "Service links depend on the runtime. Fleet network administration requires a self-hosted or desktop controller.",
    guide: "/docs/guides/mcp-clusters-and-scaling",
    title: "Private networking",
    category: "Connect",
    tagline: "Services talk over an isolated network — no exposed ports.",
    icon: Cable,
    screenshot: null,
    summary:
      "Services in a project reach each other over a private network, so your database and internal APIs never need a public port. Wire one app into another as a ready connection.",
    body: [
      "Keep internal services off public routes where the runtime supports private links. Connection wiring supplies the appropriate address and variables to a consuming project.",
      "For registered fleets, verify an existing provider network or prepare managed WireGuard networking. Changes use reviewed plans and dependency checks; cross-server reachability depends on the topology.",
    ],
    highlights: [
      { title: "No exposed ports", desc: "Internal services stay off the public internet." },
      {
        title: "One-click wiring",
        desc: "Inject a DB/service connection into another project as env vars.",
      },
      { title: "Private by default", desc: "Expose only the routes you explicitly publish." },
    ],
  },
  {
    slug: "route-rules-waf",
    availability: "Self-hosted edge controls. Managed Cloud capabilities are provider-specific.",
    guide: "/docs/guides/the-edge",
    title: "Route rules & protection",
    category: "Connect",
    tagline: "Per-route rate limits, geo/UA filters, and bans — applied live.",
    icon: ShieldAlert,
    screenshot: null,
    summary:
      "Compose per-route rules — rate limits, geo and user-agent filters, bans, hotlink protection — and apply them instantly at the edge, with no reloads and no config files.",
    body: [
      "Configure supported per-route rate limits, geographic and user-agent filters, bans, and hotlink protection from the edge controls. Apply saved policies without hand-editing proxy configuration.",
      "Inspect analytics and request logs after a policy change. These controls belong to the supported self-hosted edge; they do not imply a universal managed WAF or guaranteed DDoS mitigation.",
    ],
    highlights: [
      {
        title: "Per-route policies",
        desc: "Rate limits, geo/UA filters, bans, and hotlink protection.",
      },
      { title: "Live, no reloads", desc: "Rule changes take effect instantly at the edge." },
      { title: "Dashboard-managed", desc: "No config files — compose and edit rules visually." },
    ],
  },
  // ── Data ────────────────────────────────────────────────────────────────
  {
    slug: "managed-databases",
    guide: "/docs/reference/app-catalog",
    title: "Databases & service connections",
    category: "Data",
    tagline: "Database templates, private wiring, and supported cluster operations.",
    icon: Database,
    screenshot: null,
    summary:
      "Add PostgreSQL, Redis-compatible storage, MongoDB, or MariaDB templates and connect applications to their services. Configure persistent data and backups deliberately.",
    body: [
      "Review a database template's services, image versions, resources, and storage. Use its connection details in your app and keep persistent data separate from replacement containers.",
      "Prepared clusters have a separate PostgreSQL and Redis lifecycle with supported replication or sharding, recovery, imports, and upgraded copies. These operations differ from standalone database templates.",
    ],
    highlights: [
      {
        title: "Database templates",
        desc: "Explore database stacks and administration tools in the catalog.",
      },
      {
        title: "Application wiring",
        desc: "Use supported internal or published service addresses.",
      },
      { title: "Data recovery", desc: "Configure backups and test the restore workflow." },
    ],
  },
  {
    slug: "mail",
    availability:
      "Mail-server provisioning is available through desktop and self-hosted Openship. The hosted Cloud mail console is not available yet.",
    guide: "/docs/guides/email-webmail",
    title: "Mail server & webmail",
    category: "Data",
    tagline: "Self-hosted mail, or relay through Amazon SES / SMTP.",
    icon: Mail,
    screenshot: "/email-preview.png",
    summary:
      "Run mail on your domain with mailbox administration and built-in webmail, or connect webmail to an existing provider. Configure supported outbound relays.",
    body: [
      "Mail setup guides server selection, domain records, and the stack. Manage mailboxes and aliases in Openship and use webmail alongside desktop or mobile clients.",
      "Keep existing mailboxes when you only need webmail, or relay outbound mail through SMTP or a supported provider. Delivery depends on suitable DNS, host reputation, and provider settings.",
    ],
    highlights: [
      {
        title: "Self-host or relay",
        desc: "Full mail stack, or SES/SMTP send-relay — your choice.",
      },
      { title: "Domain setup", desc: "Follow guided mail DNS and authentication configuration." },
      {
        title: "Webmail included",
        desc: "A clean built-in client for the provisioned mail stack.",
      },
    ],
  },
  // ── Manage ──────────────────────────────────────────────────────────────
  {
    slug: "dashboard-cli-desktop",
    guide: "/download",
    title: "Dashboard, CLI & desktop",
    category: "Manage",
    tagline: "Deploy from a browser, a single binary, or a native app.",
    icon: LayoutDashboard,
    screenshot: "/screen.png",
    summary:
      "Drive everything from a fast web dashboard, a single-binary CLI, or a native Mac/Windows desktop app — deploys, logs, secrets, domains, and rollbacks, all in one place.",
    body: [
      "Manage projects, servers, deployments, domains, and access visually. The CLI exposes documented commands for scripts, deployment, logs, and operational workflows.",
      "The desktop app manages connected servers and local deployment. Interfaces share authorization and engine operations; availability follows the chosen controller and destination.",
    ],
    highlights: [
      {
        title: "Web dashboard",
        desc: "Inspect deployments, services, infrastructure, and team access.",
      },
      { title: "CLI", desc: "Use documented commands from a terminal or script." },
      { title: "Desktop", desc: "Manage remote destinations alongside local projects." },
    ],
  },
  {
    slug: "ai-mcp",
    guide: "/docs/mcp",
    title: "AI & MCP",
    category: "Manage",
    tagline: "Drive deploys from Claude, Cursor, or any MCP client.",
    icon: Bot,
    screenshot: null,
    summary:
      "Openship ships an MCP server, so AI agents can deploy, read logs, manage domains, and more — through standard, authenticated tools, scoped to exactly what you allow.",
    body: [
      'Connect Claude, Cursor, or any MCP client and let it operate your infrastructure with the same permissions model as a human — including narrow scopes like "only projects it creates."',
      "Every agent action runs through the same authorization and audit path as the dashboard and CLI, so AI access is powerful without being a back door.",
    ],
    highlights: [
      { title: "Standard MCP", desc: "Works with any MCP client — Claude, Cursor, and more." },
      { title: "Scoped tokens", desc: "Grant an agent only the projects and actions you choose." },
      {
        title: "Fully audited",
        desc: "Agent actions run the same authz + audit path as everything else.",
      },
    ],
  },
  {
    slug: "preview-deployments",
    title: "Preview environments",
    category: "Deploy",
    icon: Eye,
    tagline: "Review branch changes in a separate running environment.",
    summary:
      "Create a live application from a selected branch, with its own configuration, address, deployment history, and logs.",
    body: [
      "Use the project's environment switcher to add a branch. Openship copies its build settings into a new environment; deploy that environment to create its own live address for review.",
      "Each environment has independent variables and deployment history. Choose its services deliberately, share the address with reviewers, and remove the environment when it is no longer needed.",
    ],
    highlights: [
      { title: "Review URLs", desc: "Open proposed changes before merging." },
      {
        title: "Separate settings",
        desc: "Keep preview variables and data distinct from production.",
      },
      {
        title: "Branch selection",
        desc: "Create an environment from the branch you intend to review.",
      },
    ],
    guide: "/docs/guides/preview-environments",
    screenshot: null,
  },
  {
    slug: "actions-ci",
    title: "Actions & CI",
    category: "Run",
    icon: Workflow,
    tagline: "GitHub-compatible workflows with visual editing and live execution.",
    summary:
      "Build, test, and automate with workflows linked to projects or saved independently. Edit job dependencies, steps, matrices, and YAML in one editor.",
    body: [
      "Files in .openship/workflows/ and standalone definitions are scheduled by Openship and executed with act. Manual, repository-event, and scheduled triggers use Openship permissions, capacity, and run history without GitHub's Actions scheduler.",
      "Files in .github/workflows/ stay coordinated by GitHub. Official runners execute matching jobs on your selected destinations, while GitHub manages workflow credentials, protected environments, and results. Independent mode has documented compatibility boundaries.",
    ],
    highlights: [
      {
        title: "Visual and YAML views",
        desc: "Edit topology and steps within one workflow draft.",
      },
      {
        title: "Independent CI",
        desc: "Let Openship schedule workflows outside .github/workflows/.",
      },
      {
        title: "GitHub coordination",
        desc: "Use official runners for GitHub-coordinated workflows.",
      },
    ],
    guide: "/docs/guides/actions",
    screenshot: null,
  },
  {
    slug: "runner-destinations",
    title: "Self-hosted & Cloud runners",
    category: "Run",
    icon: ServerCog,
    tagline: "Existing servers, dedicated machines, or disposable Cloud VMs.",
    summary:
      "Choose where CI executes and how much capacity it can use. Openship checks destination capabilities and manages worker startup, cancellation, and cleanup.",
    body: [
      "Select an existing server, create a dedicated managed server, or use temporary Cloud runners. Configure OS and architecture labels, execution images, per-job CPU and memory, and parallel limits.",
      "Linux supports container or native execution; connected Macs support native jobs. Temporary jobs receive disposable Linux VMs funded from the Actions balance. Persistent destinations execute code trusted by their administrator.",
    ],
    highlights: [
      { title: "Capacity controls", desc: "Reserve parallel slots and configure job resources." },
      { title: "Capability checks", desc: "Match labels to the actual OS, CPU, and toolchain." },
      { title: "Disposable workers", desc: "Remove temporary job VMs after confirmed cleanup." },
    ],
    guide: "/docs/guides/actions#add-a-runner",
    availability:
      "Linux and native macOS are supported. Windows runner destinations are not available.",
    screenshot: null,
  },
  {
    slug: "sleep-resource-limits",
    title: "Resources & sleep mode",
    category: "Run",
    icon: Gauge,
    tagline: "Control CPU, memory, disk settings, and supported idle behavior.",
    summary:
      "Review resource allocations and configure the limits supported by your destination. Sleep settings help suitable applications avoid running continuously when idle.",
    body: [
      "Set project resource configuration and inspect effective runtime limits. Destination capabilities and plan availability determine which settings can be applied.",
      "Enable supported sleep behavior only for applications that can safely stop and start. Always-on workers and databases need different settings from an intermittently used web application; review the runtime-specific behavior first.",
    ],
    highlights: [
      { title: "Explicit allocations", desc: "Review CPU, RAM, disk, and runtime settings." },
      { title: "Usage visibility", desc: "Compare configured resources with observed usage." },
      { title: "Idle controls", desc: "Choose sleep behavior appropriate to the workload." },
    ],
    guide: "/docs/guides/sleep-mode-resources",
    screenshot: null,
  },
  {
    slug: "edge-routing",
    title: "Edge & path routing",
    category: "Connect",
    icon: Waypoints,
    tagline: "Route domains and specific paths to the right services.",
    summary:
      "Manage the proxy between public requests and your application. Keep whole-domain routes and supported exact or prefix paths attached to their intended services.",
    body: [
      "Publish the endpoints a service needs and associate them with the correct runtime port. Supported path rules allow applications to share a host across several services.",
      "Migration preserves discovered path-only routes. A host that publishes only selected paths stays path-specific, and unmatched requests do not need an invented catch-all service. Review actual routing conflicts in the migration plan.",
    ],
    highlights: [
      {
        title: "Service destinations",
        desc: "Connect public addresses to the intended runtime and port.",
      },
      { title: "Path-aware routes", desc: "Preserve supported exact and prefix rules." },
      { title: "Routing recovery", desc: "Inspect status and retry failed configuration." },
    ],
    guide: "/docs/guides/the-edge",
    screenshot: null,
  },
  {
    slug: "webhooks",
    title: "Webhooks & external triggers",
    category: "Connect",
    icon: Webhook,
    tagline: "Trigger supported automation from authenticated external events.",
    summary:
      "Connect a script or another system to deployment and job workflows through incoming webhooks, with execution visible in Openship.",
    body: [
      "Configure a hook for the supported action, such as redeploying a project or invoking a job. Use its required token or signature mechanism rather than exposing an unauthenticated command endpoint.",
      "Repository webhooks also feed automatic deployments and Actions events. The triggered operation follows the normal authorization and execution pipeline, with its own status and logs.",
    ],
    highlights: [
      {
        title: "External automation",
        desc: "Connect scripts, another CI system, or event sources.",
      },
      { title: "Authenticated hooks", desc: "Use the configured token or signature verification." },
      { title: "Visible outcomes", desc: "Follow triggered operations in run history." },
    ],
    guide: "/docs/api/webhooks",
    screenshot: null,
  },
  {
    slug: "git-authentication",
    title: "Git source access",
    category: "Connect",
    icon: GitPullRequest,
    tagline: "GitHub Apps and saved credentials for private source.",
    summary:
      "Connect the repositories your applications and workflows need. Manage source access separately from the runtime environment.",
    body: [
      "Authorize a GitHub App installation or configure supported Git credentials. Repository discovery and checkout use the selected connection and its permissions.",
      "Self-hosted instances can configure their own GitHub App. Workflow editing and official runner management need additional permissions; review installation access when a repository or operation is unavailable.",
    ],
    highlights: [
      { title: "Private repositories", desc: "Use authorized discovery and checkout." },
      { title: "Self-hosted App", desc: "Configure a GitHub App for your instance." },
      {
        title: "Scoped source access",
        desc: "Grant the repository permissions required by your workflow.",
      },
    ],
    guide: "/docs/guides/git-authentication",
    screenshot: null,
  },
  {
    slug: "app-catalog",
    title: "Ready-to-deploy apps",
    category: "Data",
    icon: Grid2X2,
    tagline: "Backends, databases, publishing tools, and automation templates.",
    summary:
      "Start with a ready-to-deploy template. Explore an app's features, included services, and requirements before choosing where it should live.",
    body: [
      "Browse the public catalog by category or search names, descriptions, and features. Detail pages explain services, resources, source links, availability, and deployment information.",
      "Select a destination and configure the template's inputs. Some entries contain persistent services or a dedicated setup flow, so requirements and availability are shown per app.",
    ],
    highlights: [
      { title: "Public browsing", desc: "Explore the catalog before signing in." },
      { title: "Detailed entries", desc: "Review features, services, and resource requirements." },
      {
        title: "Your destination",
        desc: "Deploy available templates on supported infrastructure.",
      },
    ],
    guide: "/apps",
    screenshot: null,
  },
  {
    slug: "persistent-storage",
    title: "Volumes & persistent files",
    category: "Data",
    icon: HardDrive,
    tagline: "Keep application data outside replacement containers.",
    summary:
      "Attach persistent storage to services that need files across releases. Review mounts separately from application images and include them in recovery planning.",
    body: [
      "Declare supported volumes and mount paths in project or Compose configuration. Data in persistent mounts follows its storage lifecycle instead of the replacement container lifecycle.",
      "Prepared clusters can use project-owned shared volumes with supported attachment health, expansion, and external backups. Node-local mounts need a deliberate data transfer when moving servers.",
    ],
    highlights: [
      {
        title: "Persistent mounts",
        desc: "Retain database and application files across releases.",
      },
      { title: "Storage visibility", desc: "Review paths and ownership before changing a stack." },
      { title: "Shared cluster files", desc: "Use supported volumes on prepared clusters." },
    ],
    guide: "/docs/guides/persistent-storage",
    screenshot: null,
  },
  {
    slug: "backups-restore",
    title: "Backups & restore",
    category: "Data",
    icon: Archive,
    tagline: "Scheduled recovery points with your destinations and retention.",
    summary:
      "Back up supported stateful services to storage you choose. Configure schedules and retention, inspect completion, and restore deliberately.",
    body: [
      "Add an S3-compatible bucket, SFTP destination, or supported connected server; self-hosted controllers can also use local disk. Choose the service, destination, schedule, and retention policy.",
      "Inspect each backup before relying on it. A data restore and an application rollback solve different problems: choose the appropriate recovery point and follow the service-specific restore procedure.",
    ],
    highlights: [
      { title: "Your destinations", desc: "Use supported bucket, SFTP, server, or local storage." },
      {
        title: "Schedule and retention",
        desc: "Control when recovery points are created and kept.",
      },
      {
        title: "Restore workflows",
        desc: "Inspect an archive and follow supported recovery steps.",
      },
    ],
    guide: "/docs/guides/backups-restore",
    screenshot: null,
  },
  {
    slug: "object-storage",
    title: "S3-compatible object storage",
    category: "Data",
    icon: Cloud,
    tagline: "Deploy MinIO or connect an existing bucket for backups.",
    summary:
      "Use object storage for application files and recovery copies. Openship includes a MinIO template and S3-compatible backup destinations.",
    body: [
      "Review the MinIO template's services and persistent storage before deploying it. Configure the application's endpoint and credentials through its environment settings.",
      "Connect an existing S3-compatible bucket for backups, including S3, R2, B2, or MinIO. Bucket replication and lifecycle capabilities belong to the selected storage service; Openship manages its configured backup destination and retention.",
    ],
    highlights: [
      { title: "MinIO template", desc: "Deploy an S3-compatible service from the catalog." },
      { title: "Existing buckets", desc: "Use your current S3-compatible backup provider." },
      { title: "Connection settings", desc: "Set endpoint, bucket, region, and credentials." },
    ],
    guide: "/apps/minio",
    screenshot: null,
  },
  {
    slug: "server-management",
    title: "Servers & infrastructure",
    category: "Manage",
    icon: Server,
    tagline: "Connect hosts, inspect capabilities, and manage supported services.",
    summary:
      "Keep deployment destinations in one inventory with connection health, runtime capabilities, and resource information.",
    body: [
      "Register an SSH-accessible server or create supported managed compute. Inspect its state before choosing it as an application, build, or Actions destination.",
      "Operations expose progress and destination-specific controls. Self-hosted infrastructure supports owned modules and containers; Cloud lifecycle controls follow the managed plan and provider capabilities.",
    ],
    highlights: [
      { title: "Server inventory", desc: "See destinations connected to your workspace." },
      { title: "Capability checks", desc: "Verify connectivity and runtime prerequisites." },
      { title: "Managed operations", desc: "Follow installation and lifecycle progress." },
    ],
    guide: "/docs/guides/custom-servers",
    screenshot: null,
  },
  {
    slug: "migration-import",
    title: "Workload migration & import",
    category: "Manage",
    icon: ArrowRightLeft,
    tagline: "Discover existing services and review their migration plan.",
    summary:
      "Move supported workloads between servers or adopt an existing stack. Inspect services, images, data, and routes before applying a plan.",
    body: [
      "Discover the source and select the services to move. Review ports, storage, environment settings, routing, and shared dependencies before cutover.",
      "Migration records progress and available recovery choices. Source services may stop during cutover; inspect an interrupted operation and use its supported resume or rollback path instead of blindly restarting the transfer.",
    ],
    highlights: [
      { title: "Discovery first", desc: "Inspect source services and configuration." },
      {
        title: "Routing preservation",
        desc: "Carry supported domain and path routes into the target.",
      },
      {
        title: "Recorded recovery",
        desc: "Follow progress and available resume or rollback choices.",
      },
    ],
    guide: "/docs/guides/server-to-server-migration",
    screenshot: null,
  },
  {
    slug: "instance-transfer",
    title: "Instance export & transfer",
    category: "Manage",
    icon: Download,
    tagline: "Move the Openship control plane with reviewed credential handling.",
    summary:
      "Export and import supported instance data when changing where Openship runs. Keep credentials and infrastructure bindings explicit.",
    body: [
      "Prepare an export and select the records and credentials to include. Import validates the archive and handles supported encrypted credentials for the destination.",
      "External accounts or Cloud workspace bindings may need reconnection. Preserving account protections such as 2FA requires transferring their credentials; project-only exports do not move account identity.",
    ],
    highlights: [
      { title: "Instance migration", desc: "Move supported configuration and records." },
      { title: "Credential choices", desc: "Review encrypted credentials included in the export." },
      { title: "Reconnection guidance", desc: "Resolve external bindings on the destination." },
    ],
    guide: "/docs/guides/migrate-control-plane",
    screenshot: null,
  },
  {
    slug: "notifications",
    title: "Notifications & delivery history",
    category: "Manage",
    icon: Bell,
    tagline: "Route operational events to channels and inspect delivery.",
    summary:
      "Choose the events you want to hear about. Configure notification channels and subscriptions and review delivery history.",
    body: [
      "Create a supported channel, test its configuration, and subscribe to relevant categories. Workspace defaults and personal subscriptions control where events are delivered.",
      "The inbox and delivery records keep outcomes visible. Update a channel or rotate its credentials without rebuilding application deployment settings.",
    ],
    highlights: [
      { title: "Event subscriptions", desc: "Choose relevant categories and events." },
      { title: "Channel testing", desc: "Verify a delivery path before relying on it." },
      { title: "Delivery records", desc: "Inspect outcomes and manage inbox items." },
    ],
    guide: "/docs/api/notifications",
    screenshot: null,
  },
  {
    slug: "secrets-credentials",
    title: "Secrets & saved credentials",
    category: "Secure",
    icon: KeyRound,
    tagline: "Manage application variables and encrypted infrastructure credentials.",
    summary:
      "Supply the settings applications and automation need without putting credentials in public source. Keep access under platform permissions.",
    body: [
      "Configure variables for the intended projects and services. Saved credentials cover supported Git, registry, server, and storage connections, with encrypted storage for sensitive values.",
      "Independent Actions uses configured workflow secrets and variables; GitHub-coordinated workflows use GitHub settings. Changed application variables may need a redeploy before the running process receives them.",
    ],
    highlights: [
      {
        title: "Application configuration",
        desc: "Set values for the intended project or service.",
      },
      {
        title: "Encrypted credentials",
        desc: "Save supported infrastructure connection credentials.",
      },
      { title: "Workflow scope", desc: "Configure secrets in the controller owning the workflow." },
    ],
    guide: "/docs/guides/environment-variables",
    screenshot: null,
  },
  {
    slug: "scoped-tokens",
    title: "Scoped access tokens",
    category: "Secure",
    icon: KeySquare,
    tagline: "Give an API client or agent only the capabilities it needs.",
    summary:
      "Create narrower access for automation than a full administrator account. Capabilities and resource grants control supported operations.",
    body: [
      "Choose token capabilities and resource access. Bind credentials to the intended workspace where appropriate and review grants before connecting an SDK client, script, or agent.",
      "Restricted members and scoped tokens enforce action and resource limits. Standard members and administrators are broadly trusted roles, so use explicit grants for integrations needing least privilege.",
    ],
    highlights: [
      {
        title: "Capability limits",
        desc: "Choose supported read, write, or administration operations.",
      },
      {
        title: "Resource grants",
        desc: "Restrict access to selected or permitted created resources.",
      },
      {
        title: "Revocation",
        desc: "Remove credentials when an integration no longer needs access.",
      },
    ],
    guide: "/docs/security/permissions",
    screenshot: null,
  },
  {
    slug: "audit-log",
    title: "Audit history",
    category: "Secure",
    icon: FileText,
    tagline: "Inspect recorded platform changes and export the audit trail.",
    summary:
      "Trace supported administrative and resource changes in your workspace, including the actor and affected resource.",
    body: [
      "Inspect recorded events such as membership and access changes. Use the audit view's filters to find operations relevant to an investigation.",
      "Audit visibility follows workspace permissions. Export and retention behavior are documented by the API. Records support operational review; they do not certify regulatory compliance.",
    ],
    highlights: [
      { title: "Recorded changes", desc: "Trace supported actions and affected resources." },
      {
        title: "Controlled visibility",
        desc: "Limit review to roles allowed to inspect audit records.",
      },
      { title: "Export", desc: "Retrieve records for your own retention and review." },
    ],
    guide: "/docs/api/audit",
    screenshot: null,
  },
  {
    slug: "two-factor-auth",
    title: "Passkeys & two-factor authentication",
    category: "Secure",
    icon: Fingerprint,
    tagline: "Protect sign-in with passkeys, authenticator codes, and recovery codes.",
    summary:
      "Strengthen account access through security settings. Register passkeys or enable authenticator verification with one-use recovery codes.",
    body: [
      "Enable two-factor authentication by confirming your password and verifying an authenticator code. Save recovery codes so a lost authenticator does not leave you locked out.",
      "Enabled 2FA also applies after supported social and passkey sign-in. Verified login resumes its validated destination, including invitations and authorization flows.",
    ],
    highlights: [
      { title: "Passkey sign-in", desc: "Use the supported WebAuthn flow." },
      { title: "Authenticator verification", desc: "Require a second factor when 2FA is enabled." },
      { title: "Recovery codes", desc: "Store and replace one-use account recovery codes." },
    ],
    guide: "/docs/security/auth",
    screenshot: null,
  },
  {
    slug: "deployment-health-checks",
    title: "Deployment health & preparation",
    category: "Secure",
    icon: HeartPulse,
    tagline: "Prepare replacement images and inspect application readiness.",
    summary:
      "Make release failures visible before and during activation. Prepare replacement images before activating containers and inspect health outcomes.",
    body: [
      "Registry-backed images are resolved before activation, while local builds and rollback artifacts retain their recorded provenance. A failed preparation prevents the replacement image cohort from starting cutover.",
      "Readiness depends on health settings and runtime support. Multi-service activation remains sequential; image preparation does not turn container cutover, database changes, and volume operations into one transaction.",
    ],
    highlights: [
      { title: "Image preparation", desc: "Resolve replacement images before activation." },
      {
        title: "Artifact provenance",
        desc: "Distinguish registry updates from local and retained artifacts.",
      },
      { title: "Health feedback", desc: "Inspect readiness and deployment failure details." },
    ],
    guide: "/docs/guides/rollback-redeploy",
    screenshot: null,
  },
  {
    slug: "updates",
    title: "Updates & version visibility",
    category: "Secure",
    icon: RefreshCw,
    tagline: "Review instance and supported infrastructure versions before updating.",
    summary:
      "See available Openship releases and supported managed component updates. Follow the documented workflow with a recovery plan.",
    body: [
      "Review available instance releases and their notes. Supported self-hosted infrastructure scans also compare configured and running versions of managed modules and containers.",
      "Prepare an instance backup before updating. Automatic behavior follows your configured preferences, while manual updates retain the review and recovery steps in the guide.",
    ],
    highlights: [
      { title: "Release visibility", desc: "Inspect available versions and release notes." },
      { title: "Infrastructure checks", desc: "Review supported managed component updates." },
      {
        title: "Recovery preparation",
        desc: "Follow the backup and update process for your installation.",
      },
    ],
    guide: "/docs/guides/updating",
    screenshot: null,
  },
  {
    slug: "workspaces",
    title: "Workspaces",
    category: "Collaborate",
    icon: Building2,
    tagline: "Separate projects, infrastructure, and members by workspace.",
    summary:
      "Organize work across multiple workspaces under one account. The active workspace determines the resources and operations you manage.",
    body: [
      "Create or join a workspace and switch between organizations available to your account. Resource lists and operational permissions are evaluated in the selected workspace.",
      "Cloud workspace connections carry their own binding and billing context. Invitations and scoped credentials should target the intended organization explicitly.",
    ],
    highlights: [
      {
        title: "Workspace switching",
        desc: "Move between organizations available to your account.",
      },
      {
        title: "Resource boundaries",
        desc: "Keep project and infrastructure access workspace-scoped.",
      },
      { title: "Membership", desc: "Manage the people invited to each workspace." },
    ],
    guide: "/docs/guides/teams-members",
    screenshot: null,
  },
  {
    slug: "team-roles",
    title: "Team roles",
    category: "Collaborate",
    icon: UserCog,
    tagline: "Owner, admin, member, and restricted access for teammates.",
    summary:
      "Match access to responsibility: ownership and billing, day-to-day administration, trusted membership, or explicitly restricted permissions.",
    body: [
      "Owners manage the workspace including billing. Administrators manage resources and members without billing ownership. Members have broad resource access but cannot manage membership or read the audit log.",
      "Use a restricted role for specific resources and actions. Member and admin are not read-only roles; review the permission model before delegating infrastructure access.",
    ],
    highlights: [
      { title: "Ownership", desc: "Keep billing and ownership responsibilities explicit." },
      { title: "Administration", desc: "Delegate day-to-day resource and membership management." },
      { title: "Restricted roles", desc: "Use explicit permissions instead of broad access." },
    ],
    guide: "/docs/security/permissions",
    screenshot: null,
  },
  {
    slug: "resource-permissions",
    title: "Per-resource permissions",
    category: "Collaborate",
    icon: ShieldCheck,
    tagline: "Share selected resources and actions with restricted teammates.",
    summary:
      "Grant access to a project or resource without opening the whole workspace. Restricted members begin without resource access.",
    body: [
      "Select the resource types, individual resources, and capabilities a restricted member needs. Scoped credentials use the same supported permission boundaries for automation.",
      "Multi-resource operations may require several grants, such as access to every selected server in a cluster. Access to one project does not confer administration of an entire fleet.",
    ],
    highlights: [
      { title: "Explicit grants", desc: "Choose resources accessible to the teammate." },
      { title: "Action boundaries", desc: "Select the capabilities required by the task." },
      {
        title: "Dependency checks",
        desc: "Authorize all resources in a multi-resource operation.",
      },
    ],
    guide: "/docs/security/permissions",
    screenshot: null,
  },
  {
    slug: "invitations",
    title: "Team invitations",
    category: "Collaborate",
    icon: Mailbox,
    tagline: "Invite teammates to the intended workspace and role.",
    summary:
      "Bring people into a workspace through an invitation instead of sharing administrator accounts. Select access before they join.",
    body: [
      "Create an email invitation and select the workspace role. Links expire and are checked during acceptance, with limits on invitation creation.",
      "The teammate signs in or creates an account and completes required verification. Authorized administrators can then review membership and adjust access as responsibilities change.",
    ],
    highlights: [
      { title: "Email invitations", desc: "Invite the intended teammate to your workspace." },
      { title: "Role assignment", desc: "Choose an access level before acceptance." },
      { title: "Membership review", desc: "Inspect joined members and update their access." },
    ],
    guide: "/docs/guides/teams-members",
    screenshot: null,
  },
  {
    slug: "workflow-approvals",
    title: "Workflow access & approvals",
    category: "Collaborate",
    icon: CheckCheck,
    tagline: "Decide who may run workflows and which executions need review.",
    summary:
      "Configure the audience, approval policy, and handling of untrusted requests separately from runner labels.",
    body: [
      "New workflows start with a restrictive policy. Choose who may request execution and when an authorized reviewer must approve; inspect source and destination before allowing a run.",
      "Independent and GitHub-coordinated execution both use admission checks. Untrusted fork jobs require the supported disposable destination and approval path. Independent fork jobs receive no stored secrets or write tokens.",
    ],
    highlights: [
      { title: "Allowed audience", desc: "Select who can request a workflow run." },
      { title: "Execution review", desc: "Apply approval policy to the actual run." },
      { title: "Fork handling", desc: "Use supported restricted, disposable execution." },
    ],
    guide: "/docs/guides/actions",
    screenshot: null,
  },
  {
    slug: "project-environments",
    title: "Project environments",
    category: "Collaborate",
    icon: FolderGit2,
    tagline: "Organize production, staging, and preview configuration.",
    summary:
      "Give each application environment the source, settings, and destination it needs while keeping production changes deliberate.",
    body: [
      "Use environment-specific projects and supported environment configuration for branches and destinations. Review source, variables, domains, and dependencies before deployment.",
      "Previews add a pull-request lifecycle; production should use its intended branch and release checks. Database access and persistent data remain explicit choices for each environment.",
    ],
    highlights: [
      { title: "Separate settings", desc: "Review variables, domains, and destinations." },
      { title: "Branch context", desc: "Deploy the revision intended for staging or production." },
      {
        title: "Shared visibility",
        desc: "Give teammates access to the required project context.",
      },
    ],
    guide: "/docs/api/projects#create-an-environment",
    screenshot: null,
  },
];

export function getFeature(slug: string): Feature | undefined {
  return FEATURES.find((f) => f.slug === slug);
}

export function relatedFeatures(feature: Feature, count = 3): Feature[] {
  const sameCat = FEATURES.filter(
    (f) => f.category === feature.category && f.slug !== feature.slug,
  );
  const others = FEATURES.filter((f) => f.category !== feature.category && f.slug !== feature.slug);
  return [...sameCat, ...others].slice(0, count);
}

export function categoryId(category: FeatureCategory): string {
  return category.toLowerCase();
}
