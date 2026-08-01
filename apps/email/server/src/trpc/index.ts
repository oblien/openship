/**
 * Top-level tRPC router. The exported `AppRouter` type is what the
 * client imports via `@zero/server/trpc` for type-safe RPC.
 */

import { router } from './trpc';
import { mailRouter } from './routes/mail';
import { draftsRouter } from './routes/drafts';
import { labelsRouter } from './routes/labels';
import { settingsRouter } from './routes/settings';
import { shortcutRouter } from './routes/shortcut';
import { templatesRouter } from './routes/templates';
import { userRouter } from './routes/user';
import { cookiePreferencesRouter } from './routes/cookies';
import { brandingRouter } from './routes/branding';
import { aiRouter } from './routes/ai';
import {
  brainRouter,
  bimiRouter,
  connectionsRouter,
  meetRouter,
  notesRouter,
} from './routes/stubs';

export const appRouter = router({
  mail: mailRouter,
  drafts: draftsRouter,
  labels: labelsRouter,
  settings: settingsRouter,
  shortcut: shortcutRouter,
  templates: templatesRouter,
  user: userRouter,
  cookiePreferences: cookiePreferencesRouter,
  branding: brandingRouter,

  ai: aiRouter,

  // Stubs - see `routes/stubs.ts`.
  brain: brainRouter,
  bimi: bimiRouter,
  connections: connectionsRouter,
  meet: meetRouter,
  notes: notesRouter,
});

export type AppRouter = typeof appRouter;
