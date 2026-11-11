import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { listBlockedSenders, setSenderBlocked } from "../../lib/blocked-senders";

export const blockedSendersRouter = router({
  list: protectedProcedure.query(({ ctx }) => listBlockedSenders(ctx.imap)),
  set: protectedProcedure
    .input(z.object({ email: z.email().max(254), blocked: z.boolean() }).strict())
    .mutation(({ ctx, input }) => setSenderBlocked(ctx.imap, input.email, input.blocked)),
});
