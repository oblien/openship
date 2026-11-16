import { eq } from "drizzle-orm";
import { db, schema } from "../db";

export function assistantConnection(owner: string) {
  return db
    .select()
    .from(schema.mailAssistantConnection)
    .where(eq(schema.mailAssistantConnection.mailboxId, owner))
    .get();
}
