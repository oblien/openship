import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db, schema } from "../db";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { mailboxCredentials, mailboxId, type MailboxCredentials } from "./identity";

export const mailScope = z.enum(["mail:read", "mail:draft", "mail:send"]);
export type MailScope = z.infer<typeof mailScope>;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const grantContext = (id: string, mailbox: string) => `mail-grant:${mailbox}:${id}`;

export function createGrant(
  mailbox: MailboxCredentials,
  input: {
    name: string;
    scopes: MailScope[];
    expiresInDays: number;
    internal?: boolean;
    parentId?: string;
  },
) {
  const id = randomUUID();
  const token = `osm_${randomBytes(32).toString("base64url")}`;
  const owner = mailboxId(mailbox);
  const now = Date.now();
  if (input.parentId) {
    const parent = liveGrant(input.parentId, owner);
    if (
      !parent ||
      parent.parentId ||
      input.scopes.some((scope) => !parent.scopes.includes(scope))
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "The parent connection does not grant these permissions.",
      });
    }
  }
  const count = db
    .select({ value: sql<number>`count(*)` })
    .from(schema.mailGrant)
    .where(
      and(
        eq(schema.mailGrant.mailboxId, owner),
        isNull(schema.mailGrant.revokedAt),
        gt(schema.mailGrant.expiresAt, now),
      ),
    )
    .get()!.value;
  if (count >= 20)
    throw new TRPCError({ code: "CONFLICT", message: "Revoke an unused agent connection first." });
  db.insert(schema.mailGrant)
    .values({
      id,
      mailboxId: owner,
      name: input.name,
      tokenHash: hash(token),
      scopes: [...new Set(input.scopes)],
      createdAt: now,
      internal: input.internal ?? false,
      parentId: input.parentId,
      expiresAt: now + input.expiresInDays * 86_400_000,
      credentials: encryptSecret(
        JSON.stringify(mailboxCredentials(mailbox)),
        grantContext(id, owner),
      ),
    })
    .run();
  return { id, token };
}

export function liveGrant(id: string, owner: string, scope?: MailScope) {
  const row = db
    .select()
    .from(schema.mailGrant)
    .where(and(eq(schema.mailGrant.id, id), eq(schema.mailGrant.mailboxId, owner)))
    .get();
  if (
    !row ||
    row.revokedAt ||
    row.expiresAt <= Date.now() ||
    !row.credentials ||
    (scope && !row.scopes.includes(scope))
  )
    return null;
  if (row.parentId) {
    const parent = db
      .select()
      .from(schema.mailGrant)
      .where(and(eq(schema.mailGrant.id, row.parentId), eq(schema.mailGrant.mailboxId, owner)))
      .get();
    if (
      !parent ||
      parent.parentId ||
      parent.revokedAt ||
      !parent.credentials ||
      parent.expiresAt <= Date.now() ||
      (scope && !parent.scopes.includes(scope))
    )
      return null;
  }
  return row;
}

/** Resolve again for every call. A transport session or a known id never authorizes mail access. */
export function authenticateGrant(token: string, scope?: MailScope) {
  if (!/^osm_[\w-]{43}$/.test(token)) return null;
  const found = db
    .select()
    .from(schema.mailGrant)
    .where(eq(schema.mailGrant.tokenHash, hash(token)))
    .get();
  const row = found && liveGrant(found.id, found.mailboxId, scope);
  if (!row?.credentials) return null;
  const mailbox = JSON.parse(
    decryptSecret(row.credentials, grantContext(row.id, row.mailboxId)),
  ) as MailboxCredentials;
  if (mailboxId(mailbox) !== row.mailboxId) return null;
  return { grant: row, mailbox };
}

export function listGrants(mailbox: MailboxCredentials) {
  return db
    .select({
      id: schema.mailGrant.id,
      name: schema.mailGrant.name,
      scopes: schema.mailGrant.scopes,
      createdAt: schema.mailGrant.createdAt,
      expiresAt: schema.mailGrant.expiresAt,
      revokedAt: schema.mailGrant.revokedAt,
    })
    .from(schema.mailGrant)
    .where(
      and(eq(schema.mailGrant.mailboxId, mailboxId(mailbox)), eq(schema.mailGrant.internal, false)),
    )
    .all();
}

export function revokeGrant(mailbox: MailboxCredentials, id: string) {
  return endGrant(mailboxId(mailbox), id);
}

function endGrant(owner: string, id: string) {
  db.transaction((tx) => {
    const rows = tx
      .update(schema.mailGrant)
      .set({ revokedAt: Date.now(), credentials: null })
      .where(
        and(
          eq(schema.mailGrant.mailboxId, owner),
          or(eq(schema.mailGrant.id, id), eq(schema.mailGrant.parentId, id)),
        ),
      )
      .returning({ id: schema.mailGrant.id })
      .all();
    if (!rows.some((row) => row.id === id))
      throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });
    tx.update(schema.mailJob)
      .set({
        state: "cancelled",
        credentials: null,
        updatedAt: Date.now(),
        revision: sql`${schema.mailJob.revision} + 1`,
      })
      .where(
        and(
          eq(schema.mailJob.mailboxId, owner),
          inArray(
            schema.mailJob.grantId,
            rows.map((row) => row.id),
          ),
          inArray(schema.mailJob.state, ["approval", "pending"]),
        ),
      )
      .run();
  });
  return { ok: true };
}

export function purgeExpiredGrants() {
  const rows = db
    .select()
    .from(schema.mailGrant)
    .where(and(isNull(schema.mailGrant.revokedAt), lte(schema.mailGrant.expiresAt, Date.now())))
    .all();
  for (const row of rows) {
    endGrant(row.mailboxId, row.id);
  }
  db.delete(schema.mailGrant)
    .where(
      and(
        eq(schema.mailGrant.internal, true),
        lte(schema.mailGrant.expiresAt, Date.now() - 86_400_000),
      ),
    )
    .run();
}
