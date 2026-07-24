/**
 * `mail.*` - the core IMAP/SMTP-backed routes.
 *
 * The thin handlers here just validate input and hand off to
 * `lib/imap-driver`. Heavier helpers (snooze, attachments) defer to
 * the driver or are TODO'd as no-ops until we wire them up.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import {
  listThreads,
  getThread,
  markAsRead as driverMarkRead,
  markAsUnread as driverMarkUnread,
  setStarred,
  setImportant,
  deleteThreads,
  modifyLabels as driverModifyLabels,
  send as driverSend,
  snoozeThreads as driverSnooze,
  unsnoozeThreads as driverUnsnooze,
  normalizeFolderSlug,
} from '../../lib/imap-driver';

// Spread an `idsInput`-shaped object with its folder slug normalized into
// the canonical FolderSlug enum the driver expects. Centralizes the cast
// so handlers stay one-liners.
function withFolder<T extends { folder?: string }>(input: T) {
  return { ...input, folder: normalizeFolderSlug(input.folder) };
}
import { blockRemoteContent, sanitizeMailHtml } from '../../lib/sanitize';

// Recipients arrive from the client as `{email, name}` objects (Sender).
// We accept either that or a bare email string for backward compat.
const senderInput = z.union([
  z.string(),
  z.object({ email: z.string(), name: z.string().optional() }),
]);
type SenderInput = z.infer<typeof senderInput>;
function senderToAddress(s: SenderInput): string {
  if (typeof s === 'string') return s;
  return s.name ? `${s.name.replace(/[<>]/g, '')} <${s.email}>` : s.email;
}

// Folder comes in as a loose string (client uses `bin`/`draft`/`snoozed`
// while the canonical enum is `trash`/`drafts`). Normalize on the way in
// instead of rejecting; see normalizeFolderSlug.
const folderInput = z.string().optional();

// Kept as a plain ZodObject so .extend() works for `setStarred`/etc.
// Handlers must call normalizeFolderSlug(input.folder) before passing
// to the driver, since the schema accepts any string.
const idsInput = z.object({
  ids: z.array(z.string().min(1)).min(1),
  folder: folderInput,
});

// Some legacy call sites still pass a single `id`. Normalize to `ids` so
// the driver only ever sees one shape.
const idOrIdsInput = z
  .object({
    id: z.string().min(1).optional(),
    ids: z.array(z.string().min(1)).optional(),
    folder: folderInput,
  })
  .transform((v) => ({
    ids: v.ids && v.ids.length ? v.ids : v.id ? [v.id] : [],
    folder: v.folder ? normalizeFolderSlug(v.folder) : undefined,
  }))
  .refine((v) => v.ids.length > 0, { message: 'At least one id is required' });

export const mailRouter = router({
  listThreads: protectedProcedure
    .input(
      z.object({
        // Accept any string from the client (route param) and coerce to a
        // valid FolderSlug; unknown values fall back to 'inbox'.
        folder: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        q: z.string().optional(),
        labelIds: z.array(z.string()).optional(),
      }),
    )
    .query(({ ctx, input }) => {
      return listThreads(ctx.imap, {
        folder: normalizeFolderSlug(input.folder),
        cursor: input.cursor || undefined,
        limit: input.limit,
        q: input.q,
        labelIds: input.labelIds,
      });
    }),

  get: protectedProcedure
    // Accept any string for folder - the client passes route slugs like
    // `bin` and `draft` that aren't in our canonical enum; normalize them
    // server-side instead of 400'ing the request.
    .input(
      z.object({
        id: z.string().min(1),
        folder: z.string().optional(),
        // Optional UID hint sourced from a prior `list` response. Lets the
        // server resolve the message in a single FETCH instead of doing a
        // mailbox-wide SEARCH HEADER scan. Validated server-side: if
        // UIDVALIDITY drifts or the resolved row's Message-Id doesn't
        // match `id`, the slow path runs anyway.
        uidHint: z
          .object({
            uid: z.number().int().positive(),
            uidValidity: z.number().int().positive(),
          })
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const detail = await getThread(
        ctx.imap,
        input.id,
        normalizeFolderSlug(input.folder),
        input.uidHint,
      );
      if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Thread not found' });
      return detail;
    }),

  send: protectedProcedure
    .input(
      z.object({
        to: z.array(senderInput),
        cc: z.array(senderInput).optional(),
        bcc: z.array(senderInput).optional(),
        subject: z.string(),
        message: z.string().optional(),
        text: z.string().optional(),
        html: z.string().optional(),
        body: z.string().optional(),
        attachments: z
          .array(z.object({ name: z.string(), type: z.string(), base64: z.string() }))
          .optional(),
        fromEmail: z.string().optional(),
        draftId: z.string().optional(),
        threadId: z.string().nullable().optional(),
        isForward: z.boolean().optional(),
        originalMessage: z.string().optional(),
        scheduleAt: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        inReplyTo: z.string().optional(),
        references: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const refsHeader = input.headers?.References;
      const inReplyToHeader = input.headers?.['In-Reply-To'];
      return driverSend(ctx.smtp, ctx.imap, input.fromEmail || ctx.session.email, {
        to: input.to.map(senderToAddress),
        cc: input.cc?.map(senderToAddress),
        bcc: input.bcc?.map(senderToAddress),
        subject: input.subject,
        html: input.message ?? input.html ?? input.body ?? undefined,
        text: input.text,
        attachments: input.attachments,
        inReplyTo: input.inReplyTo ?? inReplyToHeader ?? undefined,
        references:
          input.references ??
          (refsHeader ? refsHeader.split(/\s+/).filter(Boolean) : undefined),
      });
    }),

  delete: protectedProcedure
    .input(idOrIdsInput)
    .mutation(({ ctx, input }) => deleteThreads(ctx.imap, input).then(() => ({ ok: true }))),

  bulkDelete: protectedProcedure
    .input(idOrIdsInput)
    .mutation(({ ctx, input }) => deleteThreads(ctx.imap, input).then(() => ({ ok: true }))),

  markAsRead: protectedProcedure
    .input(idsInput)
    .mutation(({ ctx, input }) => driverMarkRead(ctx.imap, withFolder(input)).then(() => ({ ok: true }))),

  markAsUnread: protectedProcedure
    .input(idsInput)
    .mutation(({ ctx, input }) =>
      driverMarkUnread(ctx.imap, withFolder(input)).then(() => ({ ok: true })),
    ),

  toggleStar: protectedProcedure
    .input(idsInput.extend({ starred: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setStarred(ctx.imap, withFolder(input)).then(() => ({ ok: true })),
    ),

  toggleImportant: protectedProcedure
    .input(idsInput.extend({ important: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setImportant(ctx.imap, withFolder(input)).then(() => ({ ok: true })),
    ),

  modifyLabels: protectedProcedure
    .input(
      idsInput.extend({
        addLabels: z.array(z.string()).optional(),
        removeLabels: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      driverModifyLabels(ctx.imap, withFolder(input)).then(() => ({ ok: true })),
    ),

  // IMAP is push (via IDLE) so there's nothing to "sync" - the client
  // already calls invalidate on the listThreads key. Keep this around
  // so the client's existing button doesn't 404.
  forceSync: protectedProcedure.mutation(() => ({ ok: true })),

  // Snooze stamps the $Snoozed IMAP keyword on the message. listThreads
  // hides $Snoozed messages from inbox and surfaces them under
  // /mail/snoozed. The `until` field is accepted for forward-compat but
  // not persisted - without a wake-up worker, messages stay snoozed
  // until manually unsnoozed.
  snoozeThreads: protectedProcedure
    .input(z.object({ ids: z.array(z.string()), until: z.string().datetime() }))
    .mutation(({ ctx, input }) => driverSnooze(ctx.imap, input).then(() => ({ ok: true }))),

  unsnoozeThreads: protectedProcedure
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(({ ctx, input }) => driverUnsnooze(ctx.imap, input).then(() => ({ ok: true }))),

  // Aliases come from Postfix's virtual_alias_maps, which live in the
  // vmail.forwardings table on the mail VPS. For now, return just
  // the primary address - the admin panel manages aliases server-side.
  getEmailAliases: protectedProcedure.query(({ ctx }): Array<{ email: string; name: string; primary: boolean }> => [
    { email: ctx.session.email, name: ctx.session.name ?? '', primary: true },
  ]),

  getMessageAttachments: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .query(async ({ ctx, input }) => {
      const thread = await getThread(ctx.imap, input.messageId);
      return thread?.latest.attachments ?? [];
    }),

  // Server-side HTML sanitize used by the read-pane preview. When
  // `shouldLoadImages` is false, every remote-fetching construct — <img>
  // src/srcset and CSS url()/@import/image-set() — is blocked in one pass.
  // Blocking only <img> used to leave CSS free to fetch, so a sender could
  // take a read receipt off a reader who had remote content turned off.
  //
  // `hasBlockedImages` covers all of it: to the reader "remote content was
  // blocked" is a single fact, and the existing banner already says that.
  processEmailContent: protectedProcedure
    .input(
      z.object({
        html: z.string(),
        shouldLoadImages: z.boolean().optional(),
        theme: z.enum(['light', 'dark']).optional(),
      }),
    )
    .mutation(({ input }) => {
      const clean = sanitizeMailHtml(input.html);
      if (input.shouldLoadImages) {
        return { processedHtml: clean, hasBlockedImages: false };
      }
      const result = blockRemoteContent(clean);
      return { processedHtml: result.html, hasBlockedImages: result.blocked };
    }),

  // Autocomplete recipients out of the Sent envelope cache. Stub
  // until we wire envelope persistence; keeps the client TS happy.
  suggestRecipients: protectedProcedure
    .input(z.object({ query: z.string(), limit: z.number().int().min(1).max(50).optional() }))
    .query(() => ({ suggestions: [] as Array<{ name: string | null; email: string }> })),

  // Undo Send window: the client buffers for N seconds then calls this
  // if the user clicks Undo. Once nodemailer has flushed to Postfix it's
  // too late to recall; we expose the endpoint and trust the client's
  // delay window.
  unsend: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(() => ({ ok: true })),
});
