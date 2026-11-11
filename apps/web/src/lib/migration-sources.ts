import type { FeatureIllustrationName } from "@repo/ui/illustrations";

export const PLATFORM_MIGRATION_GUIDE = "/docs/guides/migrate-from-railway-vercel";

type MigrationSource = {
  slug: string;
  name: string;
  logo: string;
  summary: string;
  description: string;
  highlights: { illustration: FeatureIllustrationName; title: string; description: string }[];
  steps: { title: string; description: string }[];
  dataTitle: string;
  data: string[];
  questions: { q: string; a: string }[];
};

/** Public overviews of the import flow documented in the platform migration guide. */
export const MIGRATION_SOURCES: MigrationSource[] = [
  {
    slug: "from-railway",
    name: "Railway",
    logo: "railway",
    summary: "Bring your project environment, connected services and persistent data together.",
    description:
      "Move your Railway project to Openship Cloud or your own infrastructure. Review its services, copy persistent volumes, and verify the new deployment before switching your domains.",
    highlights: [
      {
        illustration: "compose-multi-service",
        title: "Your services, together",
        description:
          "Import the complete selected project environment. Each service becomes an Openship project, using its GitHub source or portable registry image.",
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
          "Railway private addresses become Openship project connections. Credentials, database names and connection options stay with them.",
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
          "Allow a maintenance window and pause external automation. Openship stops the source environment and copies all selected volumes before starting destination services.",
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
        a: "Choose an existing Railway connection or authorize your account when OAuth is configured on your Openship installation. API tokens are also supported. The connection needs access to the project and permission to stop and deploy services, update configuration, register a temporary SSH key and read storage. A read-only token cannot move persistent data.",
      },
      {
        q: "Can every Railway project move unchanged?",
        a: "Review checks compatibility before import. Scheduled jobs, multiple replicas, pre-deploy commands, multiple public ports, unsupported build settings and non-GitHub repositories need changes first. Unresolved connections and dependency cycles also need attention. Sealed variables must be re-entered; sleeping services run continuously after import.",
      },
      {
        q: "Will my application be offline?",
        a: "Plan downtime for the selected Railway environment while its volumes copy and the destination starts. Pause external jobs and deployment automation as well. Transfer time depends on your data and connection. Openship does not switch public DNS or remove your source resources automatically.",
      },
      {
        q: "Can I move to Cloud or my own server?",
        a: "Yes. The import uses Openship’s normal destination picker and its access, subscription and capacity checks. Choose managed capacity in Openship Cloud, or a connected server in your Desktop or self-hosted installation. A linked Cloud account also makes its eligible managed destinations available there.",
      },
    ],
  },
  {
    slug: "from-vercel",
    name: "Vercel",
    logo: "vercel",
    summary: "Bring your application source, environment settings and connected PostgreSQL.",
    description:
      "Bring your Vercel application to Openship Cloud or your own infrastructure. Import its GitHub source and settings, review its dependencies, and choose where its data lives.",
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
          "Use Check import to resolve blockers before starting. Openship uses its normal build and deployment flow. Pause database writers before any PostgreSQL copy.",
      },
      {
        title: "Test before switching",
        description:
          "Verify application routes, sign-in, background work and data on a test domain. Update your custom domains when ready and retire Vercel resources separately.",
      },
    ],
    dataTitle: "Choose what happens to your database",
    data: [
      "An application import does not have to move its database. You can keep a reachable external PostgreSQL connection and manage the application in Openship.",
      "To copy PostgreSQL, supply its major version and a direct public connection URL with TLS and export permissions. Pause external writers yourself and keep them paused through cutover. The logical copy includes the configured database, not other databases or server-wide roles.",
      "Vercel Blob, Edge Config, provider-specific functions and other external storage need separate handling. Review those dependencies before moving: importing source and settings does not recreate the Vercel platform or copy a Vercel filesystem.",
    ],
    questions: [
      {
        q: "How do I connect my Vercel account?",
        a: "Use a saved connection, authorize your account when OAuth is configured on your Openship installation, or add an API token. Team-scoped tokens need the team ID. Test the connection before choosing a project. Private GitHub repositories also need GitHub access in Openship.",
      },
      {
        q: "Will my app work without changes?",
        a: "Applications with supported build settings can use the normal Openship deployment flow. Review any dependence on Vercel-specific functions, APIs or storage first. Non-GitHub sources and unsupported configuration need changes before import; missing secrets must be supplied again.",
      },
      {
        q: "Does the import move my production traffic?",
        a: "No. Test the imported app and its data first, then move your custom domains through Domains & Routes. Your Vercel deployment remains at the provider until you retire it. If you copy a database, plan a maintenance window and keep writers paused until cutover.",
      },
      {
        q: "Where will the imported application run?",
        a: "Choose an eligible managed Cloud destination or a connected server in Desktop or self-hosted Openship. The normal destination permissions and capacity checks apply. Imported projects keep the usual deployment logs, domains and runtime controls; automatic deployment on Git push stays off until you enable it.",
      },
    ],
  },
];

export function getMigrationSource(slug: string) {
  return MIGRATION_SOURCES.find((source) => source.slug === slug);
}
