import { z } from "zod";
import { withImap } from "../lib/imap";
import { getThread, resolveMessageUids } from "../lib/imap-driver";
import { mailboxAuth, type MailboxCredentials } from "./identity";
import { requireMailboxSender, mailHeader, mailAttachment } from "./messages";
import { composeRfc822, decodeAttachments } from "../lib/smtp";

const DRAFTS = "Drafts";

function normalizeRecipientList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseUidHandle(id: string): number | null {
  const m = /^uid:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

export const draftInput = z.object({
  id: mailHeader.nullable().optional(),
  to: z.union([mailHeader, z.array(mailHeader).max(100)]).optional(),
  cc: z.union([mailHeader, z.array(mailHeader).max(100)]).optional(),
  bcc: z.union([mailHeader, z.array(mailHeader).max(100)]).optional(),
  subject: mailHeader.optional(),
  body: z.string().max(256_000).optional(),
  message: z.string().max(256_000).optional(),
  threadId: z.string().nullable().optional(),
  fromEmail: z.string().nullable().optional(),
  inReplyTo: mailHeader.optional(),
  references: z.array(mailHeader).max(100).optional(),
  attachments: z.array(mailAttachment).max(100).optional(),
});

export async function listDrafts(
  mailbox: MailboxCredentials,
  input: { limit?: number } | undefined,
) {
  const limit = input?.limit ?? 30;
  return withImap(mailboxAuth(mailbox).imap, async (client) => {
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
          subject: env.subject ?? "(no subject)",
          to: (env.to ?? []).map((a) => a.address ?? "").filter(Boolean),
          updatedAt: (() => {
            const d = env.date ?? msg.internalDate;
            if (!d) return new Date().toISOString();
            if (typeof d === "string") {
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
}

export async function getDraft(mailbox: MailboxCredentials, input: { id: string }) {
  const thread = await getThread(mailboxAuth(mailbox).imap, input.id, "drafts", undefined, {
    includeAttachmentBytes: true,
  });
  if (!thread || !thread.latest) return null;
  const msg = thread.latest;
  const flatten = (arr: Array<{ email?: string }> | undefined) =>
    (arr ?? []).map((a) => a.email ?? "").filter(Boolean);
  return {
    id: input.id,
    subject: msg.subject,
    content: msg.decodedBody ?? msg.body ?? "",
    to: flatten(msg.to),
    cc: flatten(msg.cc),
    bcc: flatten(msg.bcc),
    attachments: msg.attachments ?? [],
  };
}

export async function createDraft(mailbox: MailboxCredentials, input: z.infer<typeof draftInput>) {
  const from = input.fromEmail || mailbox.email;
  const toList = normalizeRecipientList(input.to);
  const ccList = normalizeRecipientList(input.cc);
  const bccList = normalizeRecipientList(input.bcc);
  const bodyHtml = input.message ?? input.body ?? "";

  // Stable Message-Id is the only thing that lets autosave round-trip.
  // Reuse the caller's id when present (a previous create() returned it)
  // so successive APPENDs always live under the same handle - list and
  // get search by `message-id` header. Without this the second save
  // would land under a new id and the composer's reload would 404.
  //
  // A `uid:<n>` handle means the caller opened a legacy draft (no
  // Message-Id in the original APPEND). Mint a fresh Message-Id for
  // the rewrite and delete the old row by UID below.
  const fromDomain = mailbox.email.split("@")[1] || "localhost";
  const legacyUid = input.id ? parseUidHandle(input.id) : null;
  const messageIdHeader =
    input.id && legacyUid === null
      ? input.id
      : `<${Date.now()}.${Math.random().toString(36).slice(2, 12)}@${fromDomain}>`;

  requireMailboxSender(input.fromEmail, mailbox.email);
  const rfc822 = await composeRfc822({
    from,
    to: toList,
    cc: ccList,
    bcc: bccList,
    subject: input.subject ?? "",
    html: bodyHtml,
    messageId: messageIdHeader,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: decodeAttachments(input.attachments),
  });
  await withImap(mailboxAuth(mailbox).imap, async (client) => {
    const lock = await client.getMailboxLock(DRAFTS);
    try {
      const previous = input.id ? await resolveMessageUids(client, input.id) : [];
      // Preserve the old draft until the replacement is safely stored. Delete only
      // the UIDs observed before APPEND, never the new copy with the same Message-Id.
      if (!(await client.append(DRAFTS, rfc822, ["\\Draft"])))
        throw new Error("Could not save the draft");
      if (previous?.length && !(await client.messageDelete(previous, { uid: true }))) {
        throw new Error("The draft was saved, but its previous copy could not be removed");
      }
    } finally {
      lock.release();
    }
  });
  return { id: messageIdHeader };
}

export async function deleteDraft(mailbox: MailboxCredentials, input: { id: string }) {
  await withImap(mailboxAuth(mailbox).imap, async (client) => {
    const lock = await client.getMailboxLock(DRAFTS);
    try {
      const uids = await resolveMessageUids(client, input.id);
      if (uids?.length && !(await client.messageDelete(uids, { uid: true })))
        throw new Error("Could not delete the draft");
    } finally {
      lock.release();
    }
  });
  return { ok: true };
}
