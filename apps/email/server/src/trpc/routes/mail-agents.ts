import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { createGrant, listGrants, revokeGrant, mailScope } from "../../mail/grants";
import {
  approveJob,
  cancelJob,
  listJobs,
  rescheduleJob,
  jobDetails,
  removeJob,
} from "../../mail/outbox";

const item = z.object({ id: z.string().min(1).max(100), revision: z.number().int().positive() });

export const mailAgentsRouter = router({
  list: protectedProcedure.query(({ ctx }) => listGrants(ctx.session)),
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(mailScope).min(1).max(3),
        expiresInDays: z.number().int().min(1).max(90).default(30),
      }),
    )
    .mutation(({ ctx, input }) => createGrant(ctx.session, input)),
  revoke: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => revokeGrant(ctx.session, input.id)),
});

export const outboxRouter = router({
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => jobDetails(ctx.session, input.id)),
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeJob(ctx.session, input.id)),
  list: protectedProcedure
    .input(
      z.object({
        offset: z.number().int().min(0).max(100_000).default(0),
        view: z.enum(["upcoming", "history"]).optional(),
      }),
    )
    .query(({ ctx, input }) => listJobs(ctx.session, input.offset, input.view)),
  cancel: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => cancelJob(ctx.session, input.id)),
  approve: protectedProcedure
    .input(item)
    .mutation(({ ctx, input }) => approveJob(ctx.session, input.id, input.revision)),
  reschedule: protectedProcedure
    .input(item.extend({ at: z.iso.datetime({ offset: true }).optional() }))
    .mutation(({ ctx, input }) => rescheduleJob(ctx.session, input.id, input.revision, input.at)),
});
