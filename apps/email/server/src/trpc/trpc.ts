/**
 * tRPC base - initT, the public `t.procedure`, and the `protected`
 * variant that enforces a signed-in session.
 *
 * Returned types are wide on purpose so the client gets useful
 * IntelliSense even before we've fully implemented every route.
 */

import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import type { AppContext } from '../ctx';
import { permitsBrowserOrigin } from '../lib/request-origin';

const t = initTRPC.context<AppContext>().create({
  transformer: superjson,
  errorFormatter({ shape }) {
    return shape;
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

const requireSession = t.middleware(({ ctx, next, type }) => {
  if (!ctx.session || !ctx.imap || !ctx.smtp) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required' });
  }
  if (type === 'mutation' && ctx.hono && !permitsBrowserOrigin(ctx.hono)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Origin not allowed' });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
      imap: ctx.imap,
      smtp: ctx.smtp,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireSession);
