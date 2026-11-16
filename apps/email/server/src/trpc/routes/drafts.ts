import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { draftInput, listDrafts, getDraft, createDraft, deleteDraft } from '../../mail/drafts';

export const draftsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional())
    .query(({ ctx, input }) => listDrafts(ctx.session, input)),
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => getDraft(ctx.session, input)),
  create: protectedProcedure
    .input(draftInput)
    .mutation(({ ctx, input }) => createDraft(ctx.session, input)),
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteDraft(ctx.session, input)),
});
