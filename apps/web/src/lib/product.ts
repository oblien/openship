/** Public product facts shared by the website and its Markdown representations. */
export const PRODUCT_SUMMARY =
  "OpenShip is an Apache 2.0 deployment platform for applications, databases and infrastructure. Run an always-on self-hosted web dashboard, use managed OpenShip Cloud, or choose the optional desktop app. Deploy through the dashboard, CLI, API, TypeScript SDK or MCP.";

export const CONTROL_PLANE_MODES = [
  {
    title: "Self-hosted web dashboard",
    description:
      "Run OpenShip on your infrastructure for an always-on dashboard, team access, webhooks and automation. Deploy on the same server or manage connected servers.",
    href: "/docs/getting-started/installation",
  },
  {
    title: "Managed OpenShip Cloud",
    description:
      "Let OpenShip operate the platform and managed compute. Your projects share the CPU, memory and storage of their Cloud Space.",
    href: "/pricing",
  },
  {
    title: "Optional desktop app",
    description:
      "Keep the control plane on your Mac, Windows or Linux computer when you want to manage servers without exposing a public dashboard. Deployed workloads keep running when the app closes.",
    href: "/download",
  },
] as const;

export const PRODUCT_ADVANTAGES = {
  control: {
    title: "Your infrastructure. Your control plane.",
    description:
      "Choose managed Cloud, an always-on self-hosted dashboard or optional Desktop. Keep the same deployment workflow as your infrastructure changes.",
    feature: "deploy-anywhere",
  },
  orchestration: {
    title: "Compose, Swarm and Kubernetes",
    description:
      "Run Compose stacks, deploy to connected Docker Swarm managers, or prepare k3s clusters with application replicas. Cluster management is available from self-hosted and desktop controllers.",
    feature: "autoscaling-load-balancing",
  },
  builds: {
    title: "Spend compute on your apps",
    description:
      "Choose the build location on supported deployment paths and reuse build caches. A build on the controller can keep compilation work off a small production server; Desktop is one way to run that controller.",
    feature: "build-performance",
  },
  edge: {
    title: "A direct path to your application",
    description:
      "OpenResty serves traffic without routing requests through the OpenShip API or database. Edge analytics aggregate in memory, and static sites can be served as files without a persistent application process.",
    feature: "traffic-analytics",
  },
  mail: {
    title: "A mail server, built in",
    description:
      "Operate domain mailboxes, webmail and mail DNS from OpenShip, with an external relay for outbound delivery. Keep email administration alongside your applications.",
    feature: "mail",
  },
  data: {
    title: "Recovery is part of the platform",
    description:
      "Schedule service backups, choose external storage and retention, and restore through a reviewed workflow. Kubernetes deployments also have dedicated PostgreSQL, Redis and shared-volume operations.",
    feature: "backups-restore",
  },
  automation: {
    title: "One platform for people and agents",
    description:
      "Use the web dashboard, CLI, API, TypeScript SDK and MCP against the same resource permissions. Add CI workflows, scoped AI agents and chat integrations when you need them.",
    feature: "ai-mcp",
  },
  ownership: {
    title: "Apache 2.0. A practical exit path.",
    description:
      "The OpenShip codebase is Apache 2.0 licensed. Deploy on servers you control, import supported Docker workloads and use transfer workflows to move applications and persistent data.",
    feature: "migration-import",
  },
} as const;

export type ProductAdvantage = keyof typeof PRODUCT_ADVANTAGES;

export const PRODUCT_QUESTIONS = [
  {
    question: "Is OpenShip only a desktop app?",
    answer:
      "No. OpenShip has an always-on self-hosted web dashboard and managed Cloud as well as an optional desktop app. Desktop is useful when you want a local control plane without a public dashboard. Webhooks and controller-managed schedules need an available controller; the applications already deployed on your servers keep running independently.",
  },
  {
    question: "Does OpenShip support Compose and multi-node deployments?",
    answer:
      "Yes. OpenShip supports native Docker Compose, deployment to connected Docker Swarm managers and k3s-based Kubernetes clusters. Self-hosted and desktop controllers can manage clusters and application replicas. Kubernetes database and distributed-storage workflows have their own setup; importing an existing Swarm stack is not the same operation as deploying a new project to Swarm.",
  },
  {
    question: "How does OpenShip reduce deployment and serving overhead?",
    answer:
      "Build location, reusable caches and static-file hosting let you avoid unnecessary production work. The OpenResty edge handles routing without an OpenShip API or database call per visitor request. Traffic analytics use bounded in-memory aggregation, keeping collection out of your application code.",
  },
  {
    question: "What does SSH-based server management mean?",
    answer:
      "OpenShip can manage connected servers over SSH without installing a full OpenShip control plane on every target. The target still needs the runtime components used by its workloads, such as Docker and an edge proxy. Runners, cluster runtimes, host integrations and AI agents can add components when those features are enabled.",
  },
  {
    question: "Are scheduled backups included?",
    answer:
      "OpenShip provides scheduled backups, retention and restore workflows for supported stateful services. Choose S3-compatible storage, SFTP, a connected server or supported local storage. Application rollback restores a release; restoring database contents uses a data backup.",
  },
  {
    question: "Can I migrate without rebuilding every service?",
    answer:
      "Existing Docker workloads can be discovered and reviewed through the server import flow. Railway and Vercel have guided imports; other platforms can move through repository, image and data migration. The correct path depends on the source, persistent data and routing. Review the matching migration guide before switching traffic.",
  },
] as const;
