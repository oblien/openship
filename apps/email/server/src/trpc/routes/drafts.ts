/**
 * Drafts router - appends to IMAP's `Drafts` mailbox with the
 * `\Draft` flag set. Listing/getting reads back from the same folder.
 *
 * Draft handles:
 *   - Preferred id is the RFC 822 Message-Id (stable, server-stamped on
 *     every APPEND we control).
 *   - Legacy drafts written by other clients may lack a Message-Id; for
 *     those we emit `uid:<n>` using the IMAP UID, which is stable within
 *     a UIDVALIDITY epoch (essentially forever for normal use, and far
 *     more durable than sequence numbers, which shift on expunge).
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { withImap } from '../../lib/imap';
import { getThread } from '../../lib/imap-driver';

const DRAFTS = 'Drafts';

function normalizeRecipientList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseUidHandle(id: string): number | null {
  const m = /^uid:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

export const draftsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 30;
      return withImap(ctx.imap, async (client) => {
        const lock = await client.getMailboxLock(DRAFTS);
        try {
          const status = await client.status(DRAFTS, { messages: true });
          const total = status.messages ?? 0;
          if (total === 0) return { drafts: [] };
          const end = total;
          const start = Math.max(1, end - limit + 1);
          const drafts: Array<{
            id: string;
            subject: string;
            to: string[];
            updatedAt: string;
          }> = [];
          for await (const msg of client.fetch(
            `${start}:${end}`,
            { uid: true, envelope: true, internalDate: true },
            { uid: false },
          )) {
            const env = msg.envelope;
            if (!env) continue;
            drafts.push({
              // Prefer Message-Id, fall back to a UID-prefixed handle.
              // Sequence numbers are deliberately *not* used here - they
              // shift after any EXPUNGE in the mailbox.
              id: env.messageId ?? `uid:${msg.uid}`,
              subject: env.subject ?? '(no subject)',
              to: (env.to ?? []).map((a) => a.address ?? '').filter(Boolean),
              updatedAt: (() => {
                const d = env.date ?? msg.internalDate;
                if (!d) return new Date().toISOString();
                if (typeof d === 'string') {
                  const parsed = new Date(d);
                  return Number.isNaN(parsed.getTime())
                    ? new Date().toISOString()
                    : parsed.toISOString();
                }
                return d.toISOString();
              })(),
            });
          }
          return { drafts: drafts.reverse() };
        } finally {
          lock.release();
        }
      });
    }),

  // Returns the flat DraftType shape the composer consumes:
  // `to`/`cc`/`bcc` are `string[]` of addresses (no name objects),
  // `content` is the sanitized HTML body, attachments are base64.
  // We lean on getThread() (which already handles uid: prefix + Message-Id
  // search + parsing) and then flatten the address arrays at the edge.
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const thread = await getThread(ctx.imap, input.id, 'drafts', undefined, {
        includeAttachmentBytes: true,
      });
      if (!thread || !thread.latest) return null;
      const msg = thread.latest;
      const flatten = (arr: Array<{ email?: string }> | undefined) =>
        (arr ?? []).map((a) => a.email ?? '').filter(Boolean);
      return {
        id: input.id,
        subject: msg.subject,
        content: msg.decodedBody ?? msg.body ?? '',
        to: flatten(msg.to),
        cc: flatten(msg.cc),
        bcc: flatten(msg.bcc),
        attachments: msg.attachments ?? [],
      };
    }),

  // The compose UI sends drafts as flat strings (comma-joined recipients,
  // `message` HTML, base64 attachments, optional `id` for upsert). We
  // normalize, write a fresh APPEND, and if `id` matched a previous draft
  // delete that one so the IMAP folder doesn't accumulate dupes.
  create: protectedProcedure
    .input(
      z.object({
        id: z.string().nullable().optional(),
        to: z.union([z.string(), z.array(z.string())]).optional(),
        cc: z.union([z.string(), z.array(z.string())]).optional(),
        bcc: z.union([z.string(), z.array(z.string())]).optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        message: z.string().optional(),
        threadId: z.string().nullable().optional(),
        fromEmail: z.string().nullable().optional(),
        inReplyTo: z.string().optional(),
        references: z.array(z.string()).optional(),
        attachments: z
          .array(
            z.object({
              name: z.string(),
              type: z.string(),
              base64: z.string(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const from = input.fromEmail || ctx.session.email;
      const toList = normalizeRecipientList(input.to);
      const ccList = normalizeRecipientList(input.cc);
      const bccList = normalizeRecipientList(input.bcc);
      const bodyHtml = input.message ?? input.body ?? '';

      // Stable Message-Id is the only thing that lets autosave round-trip.
      // Reuse the caller's id when present (a previous create() returned it)
      // so successive APPENDs always live under the same handle - list and
      // get search by `message-id` header. Without this the second save
      // would land under a new id and the composer's reload would 404.
      //
      // A `uid:<n>` handle means the caller opened a legacy draft (no
      // Message-Id in the original APPEND). Mint a fresh Message-Id for
      // the rewrite and delete the old row by UID below.
      const fromDomain = from.split('@')[1] || 'localhost';
      const legacyUid = input.id ? parseUidHandle(input.id) : null;
      const messageIdHeader =
        input.id && legacyUid === null
          ? input.id
          : `<${Date.now()}.${Math.random().toString(36).slice(2, 12)}@${fromDomain}>`;

      const headers = [
        `From: ${from}`,
        toList.length ? `To: ${toList.join(', ')}` : null,
        ccList.length ? `Cc: ${ccList.join(', ')}` : null,
        bccList.length ? `Bcc: ${bccList.join(', ')}` : null,
        `Subject: ${input.subject ?? ''}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${messageIdHeader}`,
        input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : null,
        input.references?.length ? `References: ${input.references.join(' ')}` : null,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
      ]
        .filter(Boolean)
        .join('\r\n');
      const rfc822 = Buffer.from(`${headers}\r\n\r\n${bodyHtml}`);

      await withImap(ctx.imap, async (client) => {
        if (input.id) {
          const lock = await client.getMailboxLock(DRAFTS);
          try {
            if (legacyUid !== null) {
              await client.messageDelete(String(legacyUid), { uid: true });
            } else {
              const found = await client.search(
                { header: { 'message-id': input.id } },
                { uid: true },
              );
              if (found && found.length) await client.messageDelete(found, { uid: true });
            }
          } finally {
            lock.release();
          }
        }
        await client.append(DRAFTS, rfc822, ['\\Draft']);
      });
      return { id: messageIdHeader };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await withImap(ctx.imap, async (client) => {
        const lock = await client.getMailboxLock(DRAFTS);
        try {
          const uid = parseUidHandle(input.id);
          if (uid !== null) {
            await client.messageDelete(String(uid), { uid: true });
          } else {
            const search = await client.search(
              { header: { 'message-id': input.id } },
              { uid: true },
            );
            if (search && search.length > 0) {
              await client.messageDelete(search, { uid: true });
            }
          }
        } finally {
          lock.release();
        }
      });
      return { ok: true };
    }),
});
