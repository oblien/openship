import type { PlatformImportService, PlatformMigrationReview } from "@repo/contracts";

export type ImportChoice = PlatformMigrationReview["services"][number] & { selected: boolean };
export type ImportStep = "connect" | "services" | "review";

export function missingImportVariables(
  service: PlatformImportService,
  choice: ImportChoice,
): string[] {
  return service.variables
    .filter((variable) => variable.required && !choice.env?.[variable.key])
    .map((variable) => variable.key);
}

export function importDataLabel(service: PlatformImportService, choice: ImportChoice): string {
  if (choice.data === "external") return "Keep external database";
  if (service.kind !== "database" && !service.volumes.length)
    return service.repository ? "Deploy from source" : "Deploy image";
  if (choice.data === "empty") return "Start with empty storage";
  return service.kind === "database" ? "Copy database" : "Copy files";
}

export const PLATFORM_IMPORT_HELP = {
  railway: {
    name: "Railway",
    tokenUrl: "https://railway.com/account/tokens",
    docsUrl: "https://docs.railway.com/integrations/api",
    access: "Use a workspace token and its workspace ID, or a project token for one environment.",
    data: "Openship pauses the project and copies its persistent volumes together. Allow downtime and keep Railway deployments paused until cutover.",
  },
  vercel: {
    name: "Vercel",
    tokenUrl: "https://vercel.com/account/tokens",
    docsUrl: "https://vercel.com/docs/rest-api",
    access:
      "Create a token for the account or team that owns your projects. Add the team ID for team projects.",
    data: "Linked PostgreSQL can stay external or be copied. Blob, Edge Config and other provider features need separate handling.",
  },
} as const;
