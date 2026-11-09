import type { IllustratedLinkProps } from "@/components/marketing/illustrated-link";

export const STARTING_POINTS: IllustratedLinkProps[] = [
  {
    illustration: "push-to-deploy",
    title: "A Git repository",
    description: "Connect your code, review the detected build settings, and deploy your app.",
    href: "/docs/getting-started/first-deployment",
  },
  {
    illustration: "compose-multi-service",
    title: "A Compose stack",
    description:
      "Bring your services together. Review variables, volumes, and domains before deploying.",
    href: "/docs/guides/compose-multi-service",
  },
  {
    illustration: "migration-import",
    title: "An existing Docker server",
    description: "Scan running services, review their data, and import them into Openship.",
    href: "/docs/guides/server-to-server-migration",
    note: "Includes apps running on Coolify, Dokploy, or Dokku",
  },
  {
    illustration: "instance-transfer",
    title: "An Openship instance",
    description:
      "Move your control plane from Desktop to an always-on host. Keep your workspaces together.",
    href: "/docs/guides/migrate-control-plane",
  },
];

export const STEPS = [
  {
    title: "Review your stack",
    description:
      "List your services, environment variables, data volumes, and domains. Check the destination has enough capacity.",
  },
  {
    title: "Prepare your data",
    description:
      "Take an application backup and choose how to transfer it. Plan a maintenance window for stateful services.",
  },
  {
    title: "Deploy and verify",
    description:
      "Check logs, service health, sign-in, and stored data. Make sure the app works at its destination before switching traffic.",
  },
  {
    title: "Switch your domains",
    description:
      "Update routing and verify HTTPS. Retire the old deployment after checking the new app and its backups.",
  },
];

// Keep the original campaign hashes working as visible, native page anchors.
export const REASONS: IllustratedLinkProps[] = [
  {
    id: "bill",
    illustration: "sleep-resource-limits",
    title: "Capacity shared by your projects",
    description:
      "Choose a Cloud plan with the CPU, memory, storage, and project allowance your work needs.",
    href: "/pricing",
    note: "Usage-based services are billed separately",
  },
  {
    id: "limits",
    illustration: "any-stack",
    title: "Your runtime, in a container",
    description: "Run your framework with its build and start commands, or bring a Dockerfile.",
    href: "/features/any-stack",
  },
  {
    id: "split",
    illustration: "private-networking",
    title: "Services that belong together",
    description:
      "Manage your app, workers, and database as one project with private service networking.",
    href: "/features/compose-multi-service",
  },
  {
    id: "jobs",
    illustration: "jobs-triggers",
    title: "Room for background work",
    description:
      "Run long-lived workers and scheduled jobs alongside your application, with logs in one place.",
    href: "/features/jobs-triggers",
  },
  {
    id: "lock",
    illustration: "deploy-anywhere",
    title: "Keep your hosting options open",
    description:
      "Use standard containers on Openship Cloud or your own infrastructure. The platform is open source.",
    href: "/features/deploy-anywhere",
  },
];

export function faq(from: string | null) {
  return [
    {
      q: "Do I need to rewrite my application?",
      a: "Most container-ready applications can use their existing build and start commands. Review platform-specific APIs, storage, and environment settings before moving. Services tied to your current provider may need a replacement or configuration changes.",
    },
    {
      q: "Can I import a running Docker application?",
      a: "Yes. Openship scans the source and lets you review services, volumes, environment settings, and routes before importing. You can import into Cloud or a self-hosted installation. The migration guide covers access and destination requirements.",
    },
    {
      q: "Will there be downtime?",
      a: "Plan a maintenance window when moving data between servers: the source services stop while data transfers and the destination starts. Same-server adoption can reuse running containers, but changing the reverse proxy may briefly interrupt traffic. The duration depends on your app and transfer strategy.",
    },
    {
      q: "How is Openship Cloud priced?",
      a: `${from ? `Cloud plans start at ${from}/month. ` : ""}Each plan provides a resource pool and project allowance. Apps, builds, and data share that capacity. Review the pricing page for plan limits and separately billed services such as managed proxy transfer and backups.`,
    },
    {
      q: "Can I keep my domain and DNS provider?",
      a: "Yes. Add your custom domain in Openship and follow the routing instructions for the destination. Keep the old deployment until you have verified DNS, HTTPS, and the application.",
    },
  ];
}
