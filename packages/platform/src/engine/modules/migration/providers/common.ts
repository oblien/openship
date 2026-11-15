import { AppError, detectDbImage } from "@repo/core";
import { z } from "zod";

export const providerId = z.string().min(1).max(200);
export const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
export const nodes = <T extends z.ZodType>(node: T) =>
  z.object({ edges: z.array(z.object({ node })), pageInfo });
export const envMap = z.record(
  z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .max(256),
  z.string().max(32_768),
);
export function parseProvider<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  // Zod errors can include input values. Never return or log them.
  if (!result.success)
    throw new AppError(
      "The provider returned incomplete discovery data. No workloads were imported.",
      502,
      "MIGRATION_DISCOVERY_INVALID",
    );
  return result.data;
}
export function githubRepository(raw: string | null | undefined): string | undefined {
  const value = raw?.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  return value && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : undefined;
}
export function databaseKind(image?: string) {
  const kind = detectDbImage(image)?.payloadKind;
  if (kind === "pg_dump" || kind === "mysql_dump" || kind === "mongo_dump" || kind === "redis_rdb")
    return kind;
  return undefined;
}
export const MAX_DISCOVERY_PAGES = 50;
export function nextCursor(
  current: string | undefined,
  page: z.infer<typeof pageInfo>,
): string | undefined {
  if (!page.hasNextPage) return undefined;
  if (!page.endCursor || page.endCursor === current)
    throw new AppError(
      "Provider pagination did not advance. Retry discovery.",
      502,
      "MIGRATION_DISCOVERY_INCOMPLETE",
    );
  return page.endCursor;
}
