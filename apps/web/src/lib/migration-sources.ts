import type { FeatureIllustrationName } from "@repo/ui/illustrations";
import type { StaticImageData } from "next/image";
import type { MigrationSourceKind } from "@repo/core";
import railwayReview from "../../public/migrations/railway-review.webp";
import vercelReview from "../../public/migrations/vercel-review.webp";

export const PLATFORM_MIGRATION_GUIDE = "/docs/guides/migrate-from-railway-vercel";

type MigrationSource = {
  slug: string;
  importSource: MigrationSourceKind;
  name: string;
  logos: string[];
  headline: string;
  guide: string;
  summary: string;
  description: string;
  screenshot?: { image: StaticImageData; alt: string; caption: string };
  highlights: { illustration: FeatureIllustrationName; title: string; description: string }[];
  steps: { title: string; description: string }[];
  dataTitle: string;
  data: string[];
  questions: { q: string; a: string }[];
};

/** Public guides reuse the platform-import or existing Docker migration flow. */
export const MIGRATION_SOURCES: MigrationSource[] = [
  {
    slug: "from-railway",
    importSource: "railway",
    name: "Railway",
    logos: ["railway"],
    headline: "Your Railway project.",
    guide: PLATFORM_MIGRATION_GUIDE,
    summary: "Bring your project environment, connected services and persistent data together.",
    description:
      "Move your Railway project to OpenShip Cloud or your own infrastructure. Review its services, copy persistent volumes, and verify the new deployment before switching your domains.",
    screenshot: {
      image: railwayReview,
      alt: "Railway import review showing a Storefront app, PostgreSQL and Redis, with a downtime acknowledgment before importing.",
      caption:
        "Review services, persistent data and the destination before starting. Sample project shown.",
    },
    highlights: [
      {
        illustration: "compose-multi-service",
        title: "Your services, together",
        description:
          "Import the complete selected environment into one OpenShip project. Its services stay together, using compatible GitHub sources or portable registry images.",
      },
      {
        illustration: "persistent-storage",
        title: "The data on your volumes",
        description:
          "Copy database directories, queues, SQLite and uploaded files through the same volume transfer. Keep compatible images and storage formats.",
      },
      {
        illustration: "private-networking",
        title: "Connections between services",
        description:
          "Railway private addresses resolve through service names on the project's private network. Credentials, database names and connection options stay with them.",
      },
      {
        illustration: "secrets-credentials",
        title: "Settings you can review",
        description:
          "Bring exportable variables and supported build, health check and restart settings. Re-enter sealed secrets and review domains before import.",
      },
    ],
    steps: [
      {
        title: "Connect Railway",
        description:
          "Open New project → Import existing project → Railway. Choose a saved connection or add one, test access, then select a project and environment.",
      },
      {
        title: "Review the whole environment",
        description:
          "Check every service, supply missing secrets and choose your Cloud plan or connected server. Check import shows what needs attention before you proceed.",
      },
      {
        title: "Pause, copy and deploy",
        description:
          "Allow a maintenance window and pause external automation. OpenShip stops the source environment and copies all selected volumes before starting destination services.",
      },
      {
        title: "Verify, then move traffic",
        description:
          "Follow the saved migration, check health and data, and add a test domain. Move your custom domains when ready, then retire the old resources yourself.",
      },
    ],
    dataTitle: "Your volumes move with your apps",
    data: [
      "Railway imports copy persistent volumes while the source services are stopped. Files, database directories, ownership, permissions and symlinks transfer into new destination volumes. All copies finish before destination applications start.",
      "This preserves the stored data without choosing a separate export tool for each database. It requires compatible application images and data formats: a migration is not a database version upgrade, and files outside persistent volumes are not copied.",
      "The source configuration is restored after copying and its services remain stopped for cutover. Source volumes and domains are not deleted. If the import fails, recovery stops the destination workloads it started before restoring the source; interrupted or changed environments can require review.",
    ],
    questions: [
      {
        q: "Do I need an API token?",
        a: "Choose an existing Railway connection or authorize your account when OAuth is configured on your OpenShip installation. API tokens are also supported. The connection needs access to the project and permission to stop and deploy services, update configuration, register a temporary SSH key and read storage. A read-only token cannot move persistent data.",
      },
      {
        q: "Can every Railway project move unchanged?",
        a: "Review checks compatibility before import. Source-built services must share a GitHub repository and deployed revision. Scheduled jobs, multiple replicas, pre-deploy commands, multiple public ports and unsupported build settings need changes first. Unresolved connections and dependency cycles also need attention. Sealed variables must be re-entered; sleeping services run continuously after import.",
      },
      {
        q: "Will my application be offline?",
        a: "Plan downtime for the selected Railway environment while its volumes copy and the destination starts. Pause external jobs and deployment automation as well. Transfer time depends on your data and connection. OpenShip does not switch public DNS or remove your source resources automatically.",
      },
      {
        q: "Can I move to Cloud or my own server?",
        a: "Yes. The import uses OpenShip’s normal destination picker and its access, subscription and capacity checks. Choose managed capacity in OpenShip Cloud, or a connected server in your Desktop or self-hosted installation. A linked Cloud account also makes its eligible managed destinations available there.",
      },
    ],
  },
  {
    slug: "from-vercel",
    importSource: "vercel",
    name: "Vercel",
    logos: ["vercel"],
    headline: "Your Vercel project.",
    guide: PLATFORM_MIGRATION_GUIDE,
    summary: "Bring your application source, environment settings and connected PostgreSQL.",
    description:
      "Bring your Vercel application to OpenShip Cloud or your own infrastructure. Import its GitHub source and settings, review its dependencies, and choose where its data lives.",
    screenshot: {
      image: vercelReview,
      alt: "Vercel import review showing Storefront source and a PostgreSQL database selected for copying, with source writes requiring a pause.",
      caption: "Check the app and your PostgreSQL choice before moving data. Sample project shown.",
    },
    highlights: [
      {
        illustration: "push-to-deploy",
        title: "The source you deployed",
        description:
          "Import the GitHub repository and deployed commit from the latest ready deployment in your selected production or preview environment.",
      },
      {
        illustration: "secrets-credentials",
        title: "Build and environment settings",
        description:
          "Review supported build, root and output settings with exportable variables. Re-enter Secret or Sensitive values before deploying.",
      },
      {
        illustration: "backups-restore",
        title: "A choice for PostgreSQL",
        description:
          "Keep your external database connection, or copy its configured database using a logical backup from a direct, public PostgreSQL URL with TLS.",
      },
      {
        illustration: "domains-ssl",
        title: "Your custom domains",
        description:
          "Review discovered domains and verify the app at its destination. You choose when to update routing; provider-owned vercel.app addresses stay with Vercel.",
      },
    ],
    steps: [
      {
        title: "Connect Vercel",
        description:
          "Open New project → Import existing project → Vercel. Test your connection, then choose the project and its production or preview environment.",
      },
      {
        title: "Review settings and data",
        description:
          "Check repository access, build settings and variables. Choose whether to keep an external PostgreSQL connection or copy the database, then select a destination.",
      },
      {
        title: "Check and import",
        description:
          "Use Check import to resolve blockers before starting. OpenShip uses its normal build and deployment flow. Pause database writers before any PostgreSQL copy.",
      },
      {
        title: "Test before switching",
        description:
          "Verify application routes, sign-in, background work and data on a test domain. Update your custom domains when ready and retire Vercel resources separately.",
      },
    ],
    dataTitle: "Choose what happens to your database",
    data: [
      "An application import does not have to move its database. You can keep a reachable external PostgreSQL connection and manage the application in OpenShip.",
      "To copy PostgreSQL, supply its major version and a direct public connection URL with TLS and export permissions. Pause external writers yourself and keep them paused through cutover. The logical copy includes the configured database, not other databases or server-wide roles.",
      "Vercel Blob, Edge Config, provider-specific functions and other external storage need separate handling. Review those dependencies before moving: importing source and settings does not recreate the Vercel platform or copy a Vercel filesystem.",
    ],
    questions: [
      {
        q: "How do I connect my Vercel account?",
        a: "Use a saved connection, authorize your account when OAuth is configured on your OpenShip installation, or add an API token. Team-scoped tokens need the team ID. Test the connection before choosing a project. Private GitHub repositories also need GitHub access in OpenShip.",
      },
      {
        q: "Will my app work without changes?",
        a: "Applications with supported build settings can use the normal OpenShip deployment flow. Review any dependence on Vercel-specific functions, APIs or storage first. Non-GitHub sources and unsupported configuration need changes before import; missing secrets must be supplied again.",
      },
      {
        q: "Does the import move my production traffic?",
        a: "No. Test the imported app and its data first, then move your custom domains through Domains & Routes. Your Vercel deployment remains at the provider until you retire it. If you copy a database, plan a maintenance window and keep writers paused until cutover.",
      },
      {
        q: "Where will the imported application run?",
        a: "Choose an eligible managed Cloud destination or a connected server in Desktop or self-hosted OpenShip. The normal destination permissions and capacity checks apply. Imported projects keep the usual deployment logs, domains and runtime controls; automatic deployment on Git push stays off until you enable it.",
      },
    ],
  },
  {
    slug: "from-coolify-dokploy",
    importSource: "server",
    name: "Coolify / Dokploy",
    logos: ["coolify", "dokploy"],
    headline: "Your existing Docker stack.",
    guide: "/docs/guides/migrate-from-coolify-dokploy-dokku",
    summary: "Use the Server or Docker import to bring your running apps, volumes and routes.",
    description:
      "Move workloads running on Coolify or Dokploy through OpenShip’s existing Server or Docker import. Connect the source server, scan its containers, and review services, data and domains before changing anything.",
    highlights: [
      {
        illustration: "compose-multi-service",
        title: "The containers already running",
        description:
          "Discover your existing Docker services and their current images. Reuse workloads on the same server, or review a move to another eligible destination.",
      },
      {
        illustration: "persistent-storage",
        title: "Volumes and application files",
        description:
          "Review each service’s storage. Reuse data in place or copy supported volumes and app-data mounts, with a maintenance window for a consistent transfer.",
      },
      {
        illustration: "secrets-credentials",
        title: "Configuration you can inspect",
        description:
          "Review detected environment settings, ports and service connections before import. Keep application images and data formats compatible.",
      },
      {
        illustration: "domains-ssl",
        title: "A separate routing decision",
        description:
          "Inspect discovered domains and proxy notices. Review any edge takeover before confirming it, and verify the destination before retiring the old workloads.",
      },
    ],
    steps: [
      {
        title: "Choose Server or Docker",
        description:
          "Open New project → Import existing project → Server or Docker. Both platforms use this shared Docker discovery flow; no separate platform token is needed.",
      },
      {
        title: "Connect the source server",
        description:
          "Choose a connected server in Desktop or self-hosted OpenShip, or add an external migration source over SSH in Cloud. Leave its applications and proxy running for discovery.",
      },
      {
        title: "Review services and storage",
        description:
          "Scan the source and select the application workloads. Review images, variables, volumes and domains, then choose an eligible destination and the data strategy.",
      },
      {
        title: "Verify before cutover",
        description:
          "Check application health, stored data and routing at the destination. Confirm the appropriate cutover only after verification; retire the old platform separately.",
      },
    ],
    dataTitle: "Keep the data strategy explicit",
    data: [
      "Coolify and Dokploy migrations use the same Docker import as an existing server. On the same server, reuse in place can keep the current application containers and volumes. A copy or cross-server move stops the source workloads while supported persistent data transfers.",
      "Cross-server moves can transfer locally built Docker images through the shared image-save and image-load pipeline. Review destination disk space and keep compatible application versions and data formats: migration does not upgrade databases or reproduce every setting of the old control plane.",
      "Discovery leaves the existing proxy running and reports routes that need review. Edge takeover and source retirement are explicit decisions. Keep backups and verify application data, HTTPS and background jobs before completing the move.",
    ],
    questions: [
      {
        q: "Is there a separate Coolify or Dokploy connector?",
        a: "No. Select Server or Docker in Import existing project. OpenShip discovers Docker workloads on the source server through its existing connection and uses the shared migration review, destination picker and transfer pipeline.",
      },
      {
        q: "What access do I need?",
        a: "Connect the source server over SSH with the permissions needed to inspect Docker and perform the reviewed migration. OpenShip also checks your access to the source and destination. You do not need a Coolify or Dokploy API token.",
      },
      {
        q: "Will everything move without changes?",
        a: "Review the scan and its notices before importing. Unsupported mounts, proxy-specific routing and services managed outside Docker can need preparation. Select application workloads rather than the old platform’s control plane or proxy. Both registry images and transferable locally built Docker images use the shared migration pipeline.",
      },
      {
        q: "Will OpenShip delete my old platform?",
        a: "Importing does not uninstall Coolify or Dokploy. Review any explicit source cutover or edge takeover before confirming it. Verify the migrated application and backups, then retire the old control plane and resources yourself.",
      },
    ],
  },
];

export function getMigrationSource(slug: string) {
  return MIGRATION_SOURCES.find((source) => source.slug === slug);
}
