/**
 * Stub routers for features we removed when self-hosting Zero
 * (AI compose/summarize, Gmail/Microsoft connections, BIMI lookups,
 * Notes, Meet, etc.). The client still references them via
 * `trpc.ai.*`, `trpc.brain.*`, etc., so we keep the shape - but every
 * procedure throws `NOT_IMPLEMENTED` at runtime.
 *
 * When/if any of these features come back, replace the stub with a
 * real router file. The client never needs to change.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { activateSession, readLiveSessionIds } from '../../lib/session-cookies';
import { inArray, eq } from 'drizzle-orm';
import { router, protectedProcedure, publicProcedure } from '../trpc';
import { db, schema } from '../../db';

function gone(name: string): never {
  throw new TRPCError({
    code: 'NOT_IMPLEMENTED',
    message: `${name} is not available on the self-hosted build.`,
  });
}

// Brain = the AI assistant (compose, summarize, label suggestions). We
// stripped the LLM integration, so reads return empty shapes (UI silently
// hides itself) and writes throw NOT_IMPLEMENTED.
const summaryShape = z.object({
  data: z.object({ short: z.string(), long: z.string() }),
  sources: z.array(z.object({ messageId: z.string(), excerpt: z.string() })),
  text: z.string(),
});
type Summary = z.infer<typeof summaryShape>;
const emptySummary: Summary = { data: { short: '', long: '' }, sources: [], text: '' };

export const brainRouter = router({
  getState: protectedProcedure.query(() => ({ enabled: false })),
  enableBrain: protectedProcedure.mutation(() => gone('brain.enableBrain')),
  disableBrain: protectedProcedure.mutation(() => gone('brain.disableBrain')),
  generateSummary: protectedProcedure
    .input(z.object({ threadId: z.string() }))
    .query((): Summary => emptySummary),
  getLabels: protectedProcedure.query(() => [] as Array<{ id: string; name: string }>),
  updateLabels: protectedProcedure.input(z.any()).mutation(() => gone('brain.updateLabels')),
  getPrompts: protectedProcedure.query(() => ({} as Record<string, string>)),
  updatePrompt: protectedProcedure.input(z.any()).mutation(() => gone('brain.updatePrompt')),
});

export const bimiRouter = router({
  getByEmail: publicProcedure
    .input(z.object({ email: z.string() }))
    .query(() => ({ logo: null as { svgContent: string } | null })),
});

export interface Connection {
  id: string;
  email: string;
  name: string | null;
  providerId: string;
  picture: string | null;
  isDefault: boolean;
}

export const connectionsRouter = router({
  // Returns one entry per session id in the `zero_sessions` cookie. The
  // active one is whichever id `zero_session` points at. Connection IDs
  // ARE the session row ids - the client doesn't need to know.
  list: protectedProcedure.query(
    async ({ ctx }): Promise<{ connections: Connection[] }> => {
      const hono = ctx.hono;
      if (!hono) {
        // Fallback for non-HTTP contexts (shouldn't happen). At minimum
        // surface the active session.
        return {
          connections: [
            {
              id: ctx.session.sessionId,
              email: ctx.session.email,
              name: ctx.session.name,
              providerId: 'imap',
              picture: null,
              isDefault: true,
            },
          ],
        };
      }
      const activeId = ctx.session.sessionId;
      const liveIds = await readLiveSessionIds(hono);
      // The active session is always present even if it somehow fell out
      // of the list cookie (e.g. cookie got truncated).
      const idsForLookup = liveIds.includes(activeId)
        ? liveIds
        : [activeId, ...liveIds];
      if (!idsForLookup.length) return { connections: [] };
      const rows = await db.query.session.findMany({
        where: inArray(schema.session.id, idsForLookup),
        columns: { id: true, email: true, name: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const connections = idsForLookup
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r): Connection => ({
          id: r.id,
          email: r.email,
          name: r.name,
          providerId: 'imap',
          picture: null,
          isDefault: r.id === activeId,
        }));
      return { connections };
    },
  ),
  getDefault: protectedProcedure.query(
    ({ ctx }): Omit<Connection, 'isDefault'> => ({
      id: ctx.session.sessionId,
      email: ctx.session.email,
      name: ctx.session.name,
      providerId: 'imap',
      picture: null,
    }),
  ),
  // Switch which session is active. Accepts the session id (== connection id).
  // We re-issue the active cookie to point at the target id. The list cookie
  // is also re-ordered so the just-activated id is first.
  setDefault: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true; email: string }> => {
      const hono = ctx.hono;
      if (!hono) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing HTTP context' });
      }
      const liveIds = await readLiveSessionIds(hono);
      if (!liveIds.includes(input.connectionId)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown session' });
      }
      const row = await db.query.session.findFirst({
        where: eq(schema.session.id, input.connectionId),
        columns: { id: true, email: true, expiresAt: true },
      });
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown session' });
      }
      await activateSession(hono, row.id, row.expiresAt, liveIds);
      return { ok: true, email: row.email };
    }),
});

export const meetRouter = router({
  create: protectedProcedure.input(z.any()).mutation(() => gone('meet.create')),
});

// Notes were a SaaS-only sidebar feature (thread-pinned comments backed by
// the Zero Postgres). Reads return [] so the panel renders empty; writes
// throw NOT_IMPLEMENTED.
export interface Note {
  id: string;
  userId: string;
  threadId: string;
  content: string;
  color: string;
  isPinned: boolean | null;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

export const notesRouter = router({
  list: protectedProcedure
    .input(z.object({ threadId: z.string() }).optional())
    .query((): { notes: Note[] } => ({ notes: [] })),
  create: protectedProcedure.input(z.any()).mutation(() => gone('notes.create')),
  update: protectedProcedure.input(z.any()).mutation(() => gone('notes.update')),
  delete: protectedProcedure.input(z.any()).mutation(() => gone('notes.delete')),
  reorder: protectedProcedure.input(z.any()).mutation(() => gone('notes.reorder')),
});
