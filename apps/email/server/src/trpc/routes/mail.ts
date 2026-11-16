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
  markAsRead as driverMarkRead,
  markAsUnread as driverMarkUnread,
  setStarred,
  setImportant,
  deleteThreads,
  modifyLabels as driverModifyLabels,
  normalizeFolderSlug,
} from '../../lib/imap-driver';

// Spread an `idsInput`-shaped object with its folder slug normalized into
// the canonical FolderSlug enum the driver expects. Centralizes the cast
// so handlers stay one-liners.
function withFolder<T extends { folder?: string }>(input: T) {
  return { ...input, folder: normalizeFolderSlug(input.folder) };
}
import { sanitizeMailHtml, blockRemoteContent } from '../../lib/sanitize';
import { sendInput, prepareMessage, mailRouteInternals } from '../../mail/messages';
import { enqueueSend, cancelJob, snooze, unsnooze } from '../../mail/outbox';
export { formatFromAddress, mailRouteInternals } from '../../mail/messages';

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
      const detail = await mailRouteInternals.getThread(
        ctx.imap,
        input.id,
        normalizeFolderSlug(input.folder),
        input.uidHint,
      );
      if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Thread not found' });
      return detail;
    }),

  send: protectedProcedure.input(sendInput).mutation(async ({ ctx, input }) => {
    const prepared = await prepareMessage(ctx.session, input);
    return enqueueSend(ctx.session, prepared, input.scheduleAt, { requestId: input.requestId });
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

  // The background worker removes the existing IMAP keyword at the chosen time.
  snoozeThreads: protectedProcedure
    .input(z.object({ ids: z.array(z.string().min(1)).min(1).max(100), until: z.iso.datetime({ offset: true }) }))
    .mutation(({ ctx, input }) => snooze(ctx.session, input.ids, input.until)),

  unsnoozeThreads: protectedProcedure
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(({ ctx, input }) => unsnooze(ctx.session, input.ids)),

  // Aliases come from Postfix's virtual_alias_maps, which live in the
  // vmail.forwardings table on the mail VPS. For now, return just
  // the primary address - the admin panel manages aliases server-side.
  getEmailAliases: protectedProcedure.query(({ ctx }): Array<{ email: string; name: string; primary: boolean }> => [
    { email: ctx.session.email, name: ctx.session.name ?? '', primary: true },
  ]),

  getMessageAttachments: protectedProcedure
    .input(z.object({ messageId: z.string().min(1), folder: folderInput }))
    .query(async ({ ctx, input }) => {
      const thread = await mailRouteInternals.getThread(
        ctx.imap,
        input.messageId,
        normalizeFolderSlug(input.folder),
        undefined,
        { includeAttachmentBytes: true },
      );
      return thread?.latest.attachments ?? [];
    }),

  // Server-side HTML sanitize used by the read-pane preview. When
  // `shouldLoadImages` is false every remote fetch in the body is
  // neutralized (src, srcset, CSS url()) and the result is flagged so the
  // client can show the "images hidden" banner.
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
      const { html, blocked } = blockRemoteContent(clean);
      return { processedHtml: html, hasBlockedImages: blocked };
    }),

  // Autocomplete recipients out of the Sent envelope cache. Stub
  // until we wire envelope persistence; keeps the client TS happy.
  suggestRecipients: protectedProcedure
    .input(z.object({ query: z.string(), limit: z.number().int().min(1).max(50).optional() }))
    .query(() => ({ suggestions: [] as Array<{ name: string | null; email: string }> })),

  // Atomic cancellation succeeds only before the background worker claims the send.
  unsend: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(({ ctx, input }) => cancelJob(ctx.session, input.messageId)),
});
