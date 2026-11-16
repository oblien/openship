/** Editorial comparisons, reviewed against the linked first-party documentation.
 * Keep provider-specific claims here; presentation and translations are shared. */
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
  runtime: string;
  migration: { href: string; method: string; preparation: string };
  sources: { title: string; href: string }[];
};

const manualMigration = { href: "/migrate/from-git", method: "Repository and data migration" };
const serverMigration = {
  href: "/migrate/from-coolify-dokploy",
  method: "Review a Docker server import",
};

export const COMPARISONS: readonly Comparison[] = [
  {
    slug: "vercel",
    name: "Vercel",
    group: "cloud",
    logo: "vercel",
    summary: "Framework-aware hosting or a portable container stack.",
    strength:
      "Vercel combines framework integrations, a delivery network and managed compute. It is a strong fit when your application relies on Vercel-specific deployment and runtime features.",
    reason:
      "Choose OpenShip when you want your web app, workers and databases in one container-based project, with a choice of managed Cloud or your own servers.",
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
    summary: "Managed container services, with a different choice of infrastructure.",
    strength:
      "Railway deploys services from source or container images and keeps their configuration, logs and metrics together. It suits teams that want to stay on Railway-managed infrastructure.",
    reason:
      "Choose OpenShip for a similar service-oriented workflow that also reaches your own servers. Cloud plans provide a pool of CPU, memory and storage shared by your projects.",
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
    summary: "Two ways to run applications on infrastructure you control.",
    strength:
      "Coolify manages applications, databases and Compose services over SSH. Both its self-hosted edition and hosted control plane use servers you provide for workloads.",
    reason:
      "Choose OpenShip if you also want a managed Cloud destination, alongside a dashboard, desktop app and CLI for working with your own infrastructure.",
    runtime: "Git, Dockerfiles, container images and Docker Compose.",
    migration: {
      ...serverMigration,
      preparation:
        "Discover the source Docker server, then review services, volumes and domains. This is a server import, not a Coolify API sync. Plan proxy ownership before moving traffic.",
    },
    sources: [{ title: "Coolify", href: "https://coolify.io/docs/core/what-is-coolify" }],
  },
  {
    slug: "dokploy",
    name: "Dokploy",
    group: "self-hosted",
    logo: "dokploy",
    summary: "Compare deployment workflows for your Docker infrastructure.",
    strength:
      "Dokploy provides application and database management with Docker and Traefik. It supports Docker Compose and Docker Stack workflows, including Swarm-based deployments.",
    reason:
      "Choose OpenShip when you want to manage projects through the same product on your servers or managed Cloud. Review orchestration differences before moving a Swarm workload.",
    runtime: "Applications, databases, Docker Compose and Docker Stack.",
    migration: {
      ...serverMigration,
      preparation:
        "Review discovered Docker workloads and persistent data. Rebuild Swarm-specific networking or scheduling where needed; discovery is not a complete transfer of a Dokploy cluster.",
    },
    sources: [
      { title: "Dokploy", href: "https://docs.dokploy.com/docs/core" },
      { title: "Docker Compose", href: "https://docs.dokploy.com/docs/core/docker-compose" },
    ],
  },
  {
    slug: "dokku",
    name: "Dokku",
    group: "self-hosted",
    summary: "A Git-push workflow or a shared visual workspace for your stack.",
    strength:
      "Dokku offers Git-push deployments on your server, with buildpacks, Dockerfile builds and plugins for backing services. It fits teams comfortable operating through the command line.",
    reason:
      "Choose OpenShip when you want application services, environments, domains and deployments visible in a dashboard, while keeping CLI and API access.",
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
    summary: "Bring your applications into a project-based deployment workflow.",
    strength:
      "CapRover runs on your server and offers application deployment, one-click apps, domains and cluster management. It fits teams already using its server and application model.",
    reason:
      "Choose OpenShip when you want Git and Compose projects, multiple deployment interfaces and the option to move workloads to managed Cloud.",
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
    summary: "Managed service types or a stack you can also run on your own servers.",
    strength:
      "Render offers web and private services, static sites, background workers, cron jobs and managed data services. It suits teams that prefer Render to operate the platform.",
    reason:
      "Choose OpenShip when the same application stack needs to run on your infrastructure as well as managed Cloud, using container images and Compose services.",
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
    summary: "Regional virtual machines or a portable project workspace.",
    strength:
      "Fly.io provides Machines: virtual machines with controls for lifecycle, resources and region placement. It suits applications designed around Fly's regional infrastructure and APIs.",
    reason:
      "Choose OpenShip when your priority is managing a container stack on your own servers or Cloud. Match the destination architecture to your latency and availability requirements.",
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
    summary: "A dyno-based platform or container services you control.",
    strength:
      "Heroku runs applications in managed dynos, with web, worker and one-off process types. It fits teams that value its established application and add-on ecosystem.",
    reason:
      "Choose OpenShip when you want to bring web processes, workers and data services into a portable container project, with control over where the stack runs.",
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
    summary: "A web delivery platform or a container home for your whole application.",
    strength:
      "Netlify combines web deployments with functions and platform services. It fits teams whose sites and workflows rely on Netlify's deployment and integration model.",
    reason:
      "Choose OpenShip when you want the web application and its supporting container services together, with the option to use your own infrastructure.",
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
    summary: "DigitalOcean-managed deployments or a choice of hosting providers.",
    strength:
      "DigitalOcean App Platform builds, deploys and scales components from Git repositories or container images. It suits teams that want a PaaS integrated with DigitalOcean.",
    reason:
      "Choose OpenShip when you want to manage deployments across your chosen servers or OpenShip Cloud. You can still use a DigitalOcean VPS as your own server.",
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
    summary: "Keep your server. Spend less time wiring deployments together.",
    strength:
      "A self-managed VPS gives you direct control of the operating system and deployment tools. It fits teams that want to assemble and maintain their own operating workflow.",
    reason:
      "Choose OpenShip to put builds, deployments, domains and service operations in one interface. Self-hosting still leaves server updates, capacity and recovery planning with you.",
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
