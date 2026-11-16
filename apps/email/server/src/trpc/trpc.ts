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
import { env } from '../env';

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
  const origin = ctx.hono?.req.header('Origin');
  if (
    type === 'mutation' &&
    origin &&
    origin !== new URL(ctx.hono!.req.url).origin &&
    !env.TRUSTED_ORIGINS.includes(origin)
  ) {
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
