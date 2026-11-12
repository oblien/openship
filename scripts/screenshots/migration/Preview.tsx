"use client";

import type { PlatformImportService, PlatformMigrationPlan } from "@repo/contracts";
import { PlatformImportReview } from "@/components/migration/PlatformImportReview";
import type { ImportChoice } from "@/components/migration/platform-import-model";

// Mounted only by capture.mjs in a temporary development route. These are sample
// projects, not customer data or a claim that a live migration completed.
const noop = () => {};

export default function Preview({ provider }: { provider: "railway" | "vercel" }) {
  const services: PlatformImportService[] = [
    {
      id: "storefront",
      name: provider === "railway" ? "Storefront API" : "Storefront",
      kind: "app",
      repository: "https://github.com/example/storefront",
      commit: "a91f7b2".padEnd(40, "0"),
      variables: [{ key: "DATABASE_URL", required: true }],
      volumes: [],
      domains: [{ hostname: "shop.example.com", portable: true }],
      warnings: [],
      blockers: [],
    },
    {
      id: "postgresql",
      name: "PostgreSQL",
      kind: "database",
      image: "postgres:17-alpine",
      external: provider === "vercel",
      variables: [],
      volumes:
        provider === "railway"
          ? [{ id: "postgres-data", mountPath: "/var/lib/postgresql/data" }]
          : [],
      domains: [],
      warnings: [],
      blockers: [],
    },
    ...(provider === "railway"
      ? [
          {
            id: "redis",
            name: "Redis",
            kind: "database" as const,
            image: "redis:7-alpine",
            variables: [],
            volumes: [{ id: "redis-data", mountPath: "/data" }],
            domains: [],
            warnings: [],
            blockers: [],
          },
        ]
      : []),
  ];
  const plan: PlatformMigrationPlan = {
    planId: "sample-import-review",
    provider,
    projectName: "Storefront",
    environmentName: "Production",
    targetServerId: "sample-production",
    services,
    warnings: [],
    ready: true,
    requiresWritePause: true,
    requiresWorkerPause: false,
    ...(provider === "railway" ? { sourceControl: "railway-project" as const } : {}),
  };
  const choices: Record<string, ImportChoice> = Object.fromEntries(
    services.map((service) => [
      service.id,
      {
        id: service.id,
        name: service.name,
        selected: true,
        data: "copy",
      },
    ]),
  );
  return (
    <div
      data-migration-capture={provider}
      className="bg-background text-foreground"
      style={{ width: 1200, padding: 28 }}
    >
      <PlatformImportReview
        plan={plan}
        choices={choices}
        targetName="Production"
        busy={false}
        writesPaused={false}
        workersPaused={false}
        onWritesPaused={noop}
        onWorkersPaused={noop}
        onEdit={noop}
        onStart={noop}
      />
    </div>
  );
}
