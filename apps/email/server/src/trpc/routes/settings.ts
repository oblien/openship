/**
 * User settings - read/write the `user_settings` row keyed by email.
 *
 * The settings JSON is owned end-to-end by the client; the server
 * just round-trips it. Defaults from `lib/schemas` fill in any new
 * keys we add over time.
 */

import { eq } from 'drizzle-orm';
import { router, protectedProcedure } from '../trpc';
import { db, schema } from '../../db';
import { userSettingsPatch, defaultUserSettings } from '../../lib/schemas';

export const settingsRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const row = await db.query.userSettings.findFirst({
      where: eq(schema.userSettings.email, ctx.session.email),
    });
    return { settings: { ...defaultUserSettings, ...(row?.settings ?? {}) } };
  }),

  save: protectedProcedure
    .input(userSettingsPatch)
    .mutation(({ ctx, input }) => {
      const email = ctx.session.email;
      return db.transaction(tx => {
        const now = new Date();
        const current = tx.select().from(schema.userSettings).where(eq(schema.userSettings.email, email)).get();
        const settings = { ...defaultUserSettings, ...current?.settings, ...input };
        tx.insert(schema.userSettings).values({ email, settings, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({ target: schema.userSettings.email, set: { settings, updatedAt: now } }).run();
        return { settings, success: true };
      }, { behavior: 'immediate' });
    }),
});
