/** Editorial comparisons, reviewed against the linked first-party documentation.
 * Keep provider-specific claims here; presentation and translations are shared. */
import type { ProductAdvantage } from "./product";

export const COMPARISONS_REVIEWED_AT = "2026-11-16";

export const COMPARISON_GROUPS = [
  {
    id: "cloud",
    title: "Managed platforms",
    description: "Compare the runtime, infrastructure and migration path.",
  },
  {
    id: "self-hosted",
    title: "Platforms on your servers",
    description: "Keep control of your infrastructure. Choose how you manage it.",
  },
  {
    id: "vps",
    title: "Doing it yourself",
    description: "Decide which parts of operating a server you want to keep.",
  },
] as const;

export type Comparison = {
  slug: string;
  name: string;
  group: (typeof COMPARISON_GROUPS)[number]["id"];
  logo?: string;
  summary: string;
  strength: string;
  reason: string;
  advantages: readonly ProductAdvantage[];
  runtime: string;
  migration: { href: string; method: string; preparation: string };
  sources: { title: string; href: string }[];
};

const manualMigration = { href: "/migrate/from-git", method: "Repository and data migration" };
const serverMigration = {
  href: "/migrate/from-coolify-dokploy",
  method: "Review a Docker server import",
};

/** The same rows feed the comparison page and its Markdown representation. */
export function comparisonRows(item: Comparison) {
  return [
    {
      label: "Where your apps run",
      ours: "Managed OpenShip Cloud, or your own servers.",
      theirs:
        item.group === "cloud"
          ? "Provider-managed infrastructure."
          : "Servers you provide and control.",
    },
    {
      label: "Deployment model",
      ours: "Git, images, native Compose, static sites and workers; connected Swarm and k3s from self-hosted or desktop controllers.",
      theirs: item.runtime,
    },
    {
      label: "Control plane",
      ours: "Always-on self-hosted web dashboard, managed Cloud or optional Desktop. Dashboard, CLI, API, SDK and MCP access.",
      theirs:
        item.group === "cloud"
          ? "The provider hosts and operates the control plane."
          : item.group === "vps"
            ? "You choose and maintain your administration and automation tools."
            : item.slug === "dokku"
              ? "A command-line deployment platform installed on your server."
              : "A server-hosted dashboard manages your workloads.",
    },
    {
      label: "Build resources",
      ours: "Choose controller or destination builds on supported paths; retain reusable caches with storage-aware cleanup.",
      theirs:
        item.slug === "coolify" || item.slug === "dokploy"
          ? "Dedicated build servers are available for applications; that path does not cover Docker Compose builds."
          : item.group === "cloud"
            ? "Builds and deployment artifacts use the provider's supported pipeline."
            : "Build infrastructure and resource allocation are yours to configure.",
    },
    {
      label: "Operating responsibility",
      ours: "Cloud infrastructure is managed. On your servers, you retain server responsibility.",
      theirs:
        item.group === "cloud"
          ? "The provider operates the platform; you configure your applications."
          : item.group === "vps"
            ? "You assemble deployments, TLS, monitoring and backups."
            : "You maintain the servers and the installed platform.",
    },
  ];
}

export const COMPARISONS: readonly Comparison[] = [
  {
    slug: "vercel",
    name: "Vercel",
    group: "cloud",
    logo: "vercel",
    summary: "Bring your frontend, backend and data onto infrastructure you control.",
    strength:
      "Vercel combines framework integrations, a delivery network and managed compute. It is a strong fit when your application relies on Vercel-specific deployment and runtime features.",
    reason:
      "Keep the framework you like and give the rest of your stack a home: web services, workers, databases and Compose projects. OpenShip adds a choice of your own servers or managed Cloud, with domains, backups and operations in one place. Its guided Vercel import gives supported GitHub projects a starting point for that move.",
    advantages: ["control", "data", "ownership"],
    runtime: "Framework deployments, Functions and other Vercel runtime services.",
    migration: {
      href: "/migrate/from-vercel",
      method: "Guided Vercel import",
      preparation:
        "Import supported GitHub projects and exportable settings. Re-enter unavailable secrets and review Vercel-specific APIs, storage and functions before switching domains.",
    },
    sources: [
      { title: "Vercel", href: "https://vercel.com/docs" },
      { title: "Vercel Functions", href: "https://vercel.com/docs/functions" },
    ],
  },
  {
    slug: "railway",
    name: "Railway",
    group: "cloud",
    logo: "railway",
    summary: "Keep the service workflow. Gain the freedom to run it on your servers.",
    strength:
      "Railway deploys services from source or container images and keeps their configuration, logs and metrics together. It suits teams that want to stay on Railway-managed infrastructure.",
    reason:
      "Move from a provider-bound project to a stack you can operate on your own infrastructure or managed OpenShip Cloud. Keep services, variables, domains and data operations together. Shared Cloud Space capacity and guided Railway imports make OpenShip a practical choice when infrastructure ownership is your next step.",
    advantages: ["control", "ownership", "automation"],
    runtime: "Container services built from source or deployed from images.",
    migration: {
      href: "/migrate/from-railway",
      method: "Guided Railway import",
      preparation:
        "Review imported services, variables and volumes. Plan a consistent data copy, pause writers when required, and test the destination before changing DNS.",
    },
    sources: [
      { title: "Railway", href: "https://docs.railway.com/services" },
      { title: "Railway pricing", href: "https://docs.railway.com/pricing/plans" },
    ],
  },
  {
    slug: "coolify",
    name: "Coolify",
    group: "self-hosted",
    logo: "coolify",
    summary: "Go from a deployment panel to a platform for infrastructure, data and automation.",
    strength:
      "Coolify manages applications, databases and Compose services over SSH. Both its self-hosted edition and hosted control plane use servers you provide for workloads.",
    reason:
      "OpenShip brings native Compose, connected Swarm and k3s workflows together with scheduled backups, mail, scoped AI agents and MCP. Use an always-on web dashboard for a team, optional Desktop for a private control plane, or managed Cloud when you want managed compute too. You can start by reviewing the Docker workloads already on your server.",
    advantages: ["orchestration", "control", "mail"],
    runtime: "Git, Dockerfiles, container images and Docker Compose.",
    migration: {
      ...serverMigration,
      preparation:
        "Discover the source Docker server, then review services, volumes and domains. This is a server import, not a Coolify API sync. Plan proxy ownership before moving traffic.",
    },
    sources: [
      { title: "Coolify", href: "https://coolify.io/docs/core/what-is-coolify" },
      {
        title: "Build servers",
        href: "https://coolify.io/docs/core/infrastructure/servers/build-servers",
      },
      { title: "Scaling", href: "https://coolify.io/docs/core/infrastructure/scaling/overview" },
    ],
  },
  {
    slug: "dokploy",
    name: "Dokploy",
    group: "self-hosted",
    logo: "dokploy",
    summary:
      "Keep Compose and Swarm. Add Kubernetes, integrated mail and a choice of control plane.",
    strength:
      "Dokploy provides application and database management with Docker and Traefik. It supports Docker Compose and Docker Stack workflows, including Swarm-based deployments.",
    reason:
      "OpenShip combines Docker and Compose deployments with connected Swarm, k3s clusters, scheduled backups and built-in mail administration. Run a self-hosted web dashboard, choose optional Desktop to keep the control plane private, or use managed Cloud. CLI, API, SDK and MCP share the same platform permissions, so automation grows with your operations.",
    advantages: ["orchestration", "mail", "automation"],
    runtime: "Applications, databases, Docker Compose and Docker Stack.",
    migration: {
      ...serverMigration,
      preparation:
        "Review discovered Docker workloads and persistent data. Existing Swarm stacks need a new OpenShip deployment; the import flow does not adopt them. Plan networking, storage and the cutover before switching traffic.",
    },
    sources: [
      { title: "Dokploy", href: "https://docs.dokploy.com/docs/core" },
      {
        title: "Build servers",
        href: "https://docs.dokploy.com/docs/core/remote-servers/build-server",
      },
      { title: "Docker Compose", href: "https://docs.dokploy.com/docs/core/docker-compose" },
    ],
  },
  {
    slug: "dokku",
    name: "Dokku",
    group: "self-hosted",
    summary: "Give your Git-push workflow a complete operations workspace.",
    strength:
      "Dokku offers Git-push deployments on your server, with buildpacks, Dockerfile builds and plugins for backing services. It fits teams comfortable operating through the command line.",
    reason:
      "Keep command-line control while making deployments, service configuration, data recovery and team access visible in a dashboard. OpenShip adds native Compose, a project topology view and scoped API and MCP access. Your team can operate the same resources without turning every maintenance task into a collection of shell commands.",
    advantages: ["automation", "data", "control"],
    runtime: "Git-push deployments, buildpacks, Dockerfiles and plugins.",
    migration: {
      href: "/docs/guides/migrate-from-coolify-dokploy-dokku",
      method: "Review a Docker server import",
      preparation:
        "Inventory Dokku apps, plugin-managed databases and mounted storage. Review each service and data export separately, and avoid having two platforms manage the same live container.",
    },
    sources: [
      { title: "Dokku", href: "https://dokku.com/docs/deployment/application-deployment/" },
    ],
  },
  {
    slug: "caprover",
    name: "CapRover",
    group: "self-hosted",
    summary: "Move beyond individual app deployments to a connected project workflow.",
    strength:
      "CapRover runs on your server and offers application deployment, one-click apps, domains and cluster management. It fits teams already using its server and application model.",
    reason:
      "Bring application code, Compose services, domains and data operations into one project. OpenShip connects that workflow to a web dashboard, CLI, SDK and MCP, with dedicated k3s and connected-Swarm paths on your infrastructure. Choose a self-hosted controller or managed Cloud as your needs change.",
    advantages: ["orchestration", "automation", "data"],
    runtime: "Container applications and one-click app definitions.",
    migration: {
      ...manualMigration,
      preparation:
        "Bring the source repository or image, recreate environment variables and export persistent data. CapRover app definitions and cluster settings are not imported automatically.",
    },
    sources: [{ title: "CapRover", href: "https://caprover.com/docs/get-started.html" }],
  },
  {
    slug: "render",
    name: "Render",
    group: "cloud",
    summary: "Keep managed convenience, with a route to infrastructure ownership.",
    strength:
      "Render offers web and private services, static sites, background workers, cron jobs and managed data services. It suits teams that prefer Render to operate the platform.",
    reason:
      "OpenShip puts web apps, workers, static sites and data services in a shared project workflow. Use managed Cloud now, or deploy on servers you control with the same platform. Native Compose, external backup destinations and migration tools give you practical control over the stack and its recovery.",
    advantages: ["control", "data", "ownership"],
    runtime: "Web services, workers, cron jobs, static sites and managed databases.",
    migration: {
      ...manualMigration,
      preparation:
        "Map each Render service to its runtime and start command. Export databases, copy persistent files and translate Blueprint settings; a render.yaml file is not an OpenShip Compose file.",
    },
    sources: [{ title: "Render", href: "https://render.com/docs/service-types" }],
  },
  {
    slug: "fly-io",
    name: "Fly.io",
    group: "cloud",
    summary: "Put your application stack, data and operations in one workspace.",
    strength:
      "Fly.io provides Machines: virtual machines with controls for lifecycle, resources and region placement. It suits applications designed around Fly's regional infrastructure and APIs.",
    reason:
      "Choose OpenShip when you want a project-level workflow for containers, Compose, domains and backups across your own servers or managed Cloud. The platform exposes the same operations through its dashboard, CLI, API and MCP. For your own multi-node infrastructure, self-hosted and desktop controllers also support k3s and connected Swarm.",
    advantages: ["control", "automation", "orchestration"],
    runtime: "Fly Machines configured through Fly Launch or the Machines API.",
    migration: {
      ...manualMigration,
      preparation:
        "Translate fly.toml settings, secrets and process groups. Plan volume and database exports, and replace Fly-specific networking. Re-test regional latency; this is not a Machines API import.",
    },
    sources: [{ title: "Fly Machines", href: "https://docs.fly.io/machines/overview" }],
  },
  {
    slug: "heroku",
    name: "Heroku",
    group: "cloud",
    summary: "Bring your processes and data together, with ownership built in.",
    strength:
      "Heroku runs applications in managed dynos, with web, worker and one-off process types. It fits teams that value its established application and add-on ecosystem.",
    reason:
      "Run web apps, workers and backing services as a portable project on your servers or managed Cloud. OpenShip combines deployments, service backups, domains and mail administration under an Apache 2.0 codebase. Move each process and data service deliberately, then keep operating them through one platform.",
    advantages: ["ownership", "data", "mail"],
    runtime: "Web, worker and one-off dynos, with backing services and add-ons.",
    migration: {
      ...manualMigration,
      preparation:
        "Map Procfile entries to services and transfer config variables. Export databases and review each add-on separately. Test release commands and scheduled jobs before cutover.",
    },
    sources: [{ title: "Heroku dynos", href: "https://devcenter.heroku.com/articles/dynos" }],
  },
  {
    slug: "netlify",
    name: "Netlify",
    group: "cloud",
    summary: "Give your site and its supporting services the same home.",
    strength:
      "Netlify combines web deployments with functions and platform services. It fits teams whose sites and workflows rely on Netlify's deployment and integration model.",
    reason:
      "Serve a static site directly at the edge, or deploy a full application alongside workers and databases. OpenShip adds native Compose, integrated mail administration and a choice of managed Cloud or your own infrastructure. Your frontend can grow into a broader stack without requiring a separate deployment panel for each part.",
    advantages: ["edge", "control", "mail"],
    runtime: "Web deployments, functions and Netlify platform services.",
    migration: {
      ...manualMigration,
      preparation:
        "Bring the repository and environment variables. Review netlify.toml, redirects, functions, forms and stored data; platform-specific behavior needs an explicit replacement or external service.",
    },
    sources: [
      { title: "Netlify Functions", href: "https://docs.netlify.com/build/functions/overview/" },
    ],
  },
  {
    slug: "digitalocean-app-platform",
    name: "DigitalOcean App Platform",
    group: "cloud",
    summary: "Choose your hosting provider without giving up a deployment platform.",
    strength:
      "DigitalOcean App Platform builds, deploys and scales components from Git repositories or container images. It suits teams that want a PaaS integrated with DigitalOcean.",
    reason:
      "Use a DigitalOcean Droplet, another connected server or managed OpenShip Cloud as your destination. OpenShip brings Git deployments, Compose, domains, service backups and automation to that infrastructure. You can keep an external managed database while taking control of where the application runs.",
    advantages: ["control", "builds", "ownership"],
    runtime: "Git or image deployments configured as App Platform components.",
    migration: {
      ...manualMigration,
      preparation:
        "Translate the app spec, environment variables and component commands. Keep external managed databases or export them deliberately. App Platform and Droplet migrations are different workflows.",
    },
    sources: [
      {
        title: "DigitalOcean App Platform",
        href: "https://docs.digitalocean.com/products/app-platform/",
      },
    ],
  },
  {
    slug: "self-managed-vps",
    name: "Self-managed VPS",
    group: "vps",
    summary: "Keep your server. Replace repeated setup with repeatable operations.",
    strength:
      "A self-managed VPS gives you direct control of the operating system and deployment tools. It fits teams that want to assemble and maintain their own operating workflow.",
    reason:
      "Keep the infrastructure you already pay for and bring deployments, HTTPS, monitoring, backups and mail into one platform. Manage targets over SSH from an always-on web dashboard or optional Desktop. Build on a supported controller path to keep compilation off production, and reuse warm caches when deploying again.",
    advantages: ["builds", "edge", "data"],
    runtime: "Your choice of processes, containers, Compose and deployment scripts.",
    migration: {
      href: "/docs/guides/server-to-server-migration",
      method: "Review a Docker server import",
      preparation:
        "Discover existing Docker services or package non-container apps first. Inventory volumes, ports and proxy rules. Back up data and decide whether to reuse the server or move to another destination.",
    },
    sources: [
      {
        title: "Docker Compose",
        href: "https://docs.docker.com/compose/intro/compose-application-model/",
      },
    ],
  },
];

export function getComparison(slug: string) {
  return COMPARISONS.find((comparison) => comparison.slug === slug);
}

export function comparisonName(comparison: Comparison, copy: (source: string) => string) {
  return comparison.group === "vps" ? copy(comparison.name) : comparison.name;
}
