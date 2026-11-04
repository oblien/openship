import { inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@repo/db/factory";
import { AFFILIATE_PARTICIPANT_PREFIX } from "@repo/platform/engine/modules/affiliates/affiliate-provider";

/** Staff-only lookup for a bounded queue page. No second participant registry or ledger. */
export async function affiliateQueueAccounts(db: Database, participantKeys: string[]) {
  if (!participantKeys.length) return new Map<string, { userId: string; email: string }>();
  if (participantKeys.length > 100 || participantKeys.some((key) => !/^[a-f0-9]{64}$/.test(key)))
    throw new TypeError("Invalid affiliate queue participant keys");
  const fingerprint = sql<string>`encode(sha256(convert_to(${AFFILIATE_PARTICIPANT_PREFIX} || ${schema.user.id}, 'UTF8')), 'hex')`;
  const rows = await db
    .select({ participantKey: fingerprint, userId: schema.user.id, email: schema.user.email })
    .from(schema.user)
    .where(inArray(fingerprint, [...new Set(participantKeys)]));
  return new Map(rows.map(({ participantKey, ...account }) => [participantKey, account]));
}
