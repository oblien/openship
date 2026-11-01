/**
 * Server-Sent Events bridge for IMAP IDLE.
 *
 * Client opens `GET /mail/idle?folder=inbox` and we hold an IMAP
 * connection open in IDLE on that mailbox. Every EXISTS / EXPUNGE /
 * FETCH from Dovecot becomes one SSE `event: mailbox` line - the
 * client invalidates the threads query in response.
 *
 * We hold one IMAP connection per SSE client. Cheap on the same VPS;
 * if we ever need to scale, share one IMAP connection per mailbox
 * across SSE clients.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getCookie } from 'hono/cookie';
import { env } from '../env';
import { getSession } from '../lib/session';
import { bridgeImapIdle } from '../lib/imap-idle';
import { createImapClient } from '../lib/imap';
import { folderToMailbox, normalizeFolderSlug } from '../lib/imap-driver';

export const idleRoute = new Hono();

idleRoute.get('/idle', async (c) => {
  const sid = getCookie(c, env.SESSION_COOKIE_NAME);
  if (!sid) return c.text('Unauthorized', 401);
  const session = await getSession(sid);
  if (!session) return c.text('Unauthorized', 401);

  const view = c.req.query('view');
  const folder = view !== undefined
    ? folderToMailbox(normalizeFolderSlug(view))
    : c.req.query('folder') || 'INBOX';

  // Nginx/OpenResty must forward each notification as it arrives.
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const client = createImapClient({
      host: session.imapHost,
      port: session.imapPort,
      user: session.email,
      pass: session.password,
    }, {
      disableAutoIdle: true,
      maxIdleTime: 25 * 60 * 1000,
    });
    await bridgeImapIdle(client, stream, folder, c.req.raw.signal);
  });
});
