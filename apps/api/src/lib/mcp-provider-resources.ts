import { randomUUID } from "node:crypto";
import { db, schema } from "@repo/db";
import { allowedMcpResources } from "./mcp-resource";

/** Public domains and desktop ports can change after boot. Seed only the
 * origin selected by the API public-origin resolver, never the resource body.
 * Preserve an existing row's disabled state and operator policy.
 */
export async function ensureMcpProviderResources(origin: string) {
  await db
    .insert(schema.oauthResource)
    .values(
      allowedMcpResources(origin).map((identifier) => ({
        id: randomUUID(),
        identifier,
        name: "Openship MCP",
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    )
    .onConflictDoNothing({ target: schema.oauthResource.identifier });
}
